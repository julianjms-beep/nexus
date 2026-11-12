import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

// The start menu of the "barra" desktop (the panther in the taskbar opens it). A search box — the apps that match
// first; Intro with no app asks NEXUS AI — every app as a tile, and at the bottom the person's name with lock,
// log out, restart and shut down (the last three ask first, like the power menu).
Window {
    id: sm
    visible: false
    color: "transparent"
    LayerShell.Window.scope: "nexus-start"
    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityExclusive

    property bool shown: false
    function open() { hideLater.stop(); q.text = ""; visible = true; shown = true; requestActivate(); q.forceActiveFocus(); Session.refreshApps() }
    function close() { if (!shown) return; shown = false; hideLater.restart() }
    function toggle() { if (shown) close(); else open() }
    Timer { id: hideLater; interval: Theme.ms(170) + 10; onTriggered: if (!sm.shown) sm.visible = false }

    readonly property var order: ["files", "browser", "editor", "code", "terminal", "agents", "automations", "connect", "mail", "store", "monitor", "settings"]
        .filter(function(id) { return id !== "code" || !!Session.apps.code })   // VS Code only while installed
        .concat(Object.keys(Session.apps).filter(function(id) { return !!Session.apps[id].store }).sort(function(a, b) { return Session.apps[a].name.localeCompare(Session.apps[b].name) }))   // what was installed from NEXUS Store
    function plain(t) {
        return String(t).toLowerCase().replace(/[áàä]/g, "a").replace(/[éèë]/g, "e").replace(/[íìï]/g, "i")
            .replace(/[óòö]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n")
    }
    readonly property string query: plain(q.text.trim())
    readonly property var matches: {
        var out = []
        for (var i = 0; i < order.length; i++) {
            var id = order[i], a = Session.apps[id], n = plain(a ? a.name : id)
            if (!query || n.indexOf(query) >= 0 || id.indexOf(query) >= 0) out.push(id)
        }
        return out
    }
    function go() {
        if (!q.text.trim()) return
        if (matches.length) launch(matches[0]); else askAi()
    }
    function launch(id) { close(); Session.launch(id) }
    function askAi() { var t = q.text.trim(); close(); if (t) Session.uiRequested("ai", t); else Session.openPanel("ai") }
    function power(action) { close(); if (action === "lock") Session.power("lock"); else Session.askLocalConfirm(action) }

    MouseArea { anchors.fill: parent; onClicked: sm.close() }

    Rectangle {
        id: card
        x: 10
        width: Math.min(560, sm.width - 20)
        height: col.height + 36
        y: sm.height - 50 - 10 - height + dy
        property real dy: sm.shown ? 0 : 16
        radius: 18
        color: Theme.dark ? Qt.rgba(0.047, 0.055, 0.086, 0.97) : Theme.card
        border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.08) : Theme.border
        opacity: sm.shown ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: Theme.ms(sm.shown ? 170 : 130); easing.type: Easing.OutCubic } }
        Behavior on dy { NumberAnimation { duration: Theme.ms(sm.shown ? 240 : 140); easing.type: Easing.OutCubic } }
        MouseArea { anchors.fill: parent }   // clicks inside never close it

        Column {
            id: col
            x: 18; y: 18
            width: parent.width - 36
            spacing: 14

            // search, or ask
            Rectangle {
                width: parent.width; height: 46; radius: 12
                color: Theme.card2
                border.color: q.activeFocus ? Theme.alpha(Theme.accent, 0.7) : Theme.border
                Behavior on border.color { ColorAnimation { duration: Theme.ms(140) } }
                LineIcon { x: 14; anchors.verticalCenter: parent.verticalCenter; name: "search"; size: 18; color: Theme.dim }
                TextInput {
                    id: q
                    x: 44; width: parent.width - 58
                    anchors.verticalCenter: parent.verticalCenter
                    color: Theme.text
                    selectionColor: Theme.alpha(Theme.accent, 0.4)
                    font.family: Theme.font; font.pixelSize: 15
                    clip: true
                    Keys.onReturnPressed: sm.go()
                    Keys.onEnterPressed: sm.go()
                    Keys.onEscapePressed: sm.close()
                    Text {
                        visible: !q.text
                        anchors.verticalCenter: parent.verticalCenter
                        text: "Busca una app o pregunta a NEXUS AI"
                        color: Theme.faint; font: q.font
                    }
                }
            }

            // what was typed, as a question for NEXUS AI
            Rectangle {
                visible: q.text.trim().length > 0
                width: parent.width; height: 44; radius: 12
                color: askMa.containsMouse || sm.matches.length === 0 ? Theme.hover : "transparent"
                border.color: sm.matches.length === 0 ? Theme.alpha(Theme.accent, 0.5) : "transparent"
                Row {
                    x: 12; anchors.verticalCenter: parent.verticalCenter
                    spacing: 10
                    LineIcon { anchors.verticalCenter: parent.verticalCenter; name: "brain"; size: 19; color: Theme.accent }
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        width: col.width - 60
                        elide: Text.ElideRight
                        text: "Preguntar a NEXUS AI: «" + q.text.trim() + "»"
                        color: Theme.text; font.family: Theme.font; font.pixelSize: 14
                    }
                }
                MouseArea { id: askMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: sm.askAi() }
            }

            Text {
                visible: sm.matches.length > 0
                text: q.text.trim() ? "Apps" : "Todas las apps"
                color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold; font.letterSpacing: 0.6
            }
            Grid {
                id: grid
                visible: sm.matches.length > 0
                columns: 4
                spacing: 6
                Repeater {
                    model: sm.matches
                    Item {
                        id: tile
                        required property string modelData
                        required property int index
                        readonly property bool first: index === 0 && q.text.trim().length > 0
                        width: Math.floor((col.width - 3 * grid.spacing) / 4); height: 92
                        Rectangle {
                            anchors.fill: parent; radius: 12
                            color: tma.pressed ? Theme.alpha(Theme.text, 0.12) : tma.containsMouse || tile.first ? Theme.hover : "transparent"
                            border.color: tile.first ? Theme.alpha(Theme.accent, 0.45) : "transparent"
                            Behavior on color { ColorAnimation { duration: Theme.ms(110) } }
                        }
                        AppIcon {
                            app: tile.modelData
                            width: 44; height: 44
                            anchors.horizontalCenter: parent.horizontalCenter
                            y: 12
                            scale: tma.pressed ? 0.92 : 1
                            Behavior on scale { NumberAnimation { duration: Theme.ms(140); easing.type: Easing.OutBack } }
                        }
                        Text {
                            anchors.horizontalCenter: parent.horizontalCenter
                            y: 64; width: parent.width - 8
                            horizontalAlignment: Text.AlignHCenter
                            elide: Text.ElideRight
                            text: (Session.apps[tile.modelData] || {}).name || tile.modelData
                            color: Theme.text; font.family: Theme.font; font.pixelSize: 13
                        }
                        MouseArea { id: tma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: sm.launch(tile.modelData) }
                    }
                }
            }
            Text {
                visible: sm.matches.length === 0
                width: parent.width
                wrapMode: Text.Wrap
                text: "Ninguna app se llama así. Pulsa Intro y se lo preguntas a NEXUS AI."
                color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
            }

            Rectangle { width: parent.width; height: 1; color: Theme.border }

            // the person, and the power buttons
            Item {
                width: parent.width; height: 40
                Row {
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 10
                    Rectangle {
                        width: 32; height: 32; radius: 16
                        anchors.verticalCenter: parent.verticalCenter
                        gradient: Gradient {
                            orientation: Gradient.Horizontal
                            GradientStop { position: 0; color: "#22d3ee" }
                            GradientStop { position: 1; color: "#a855f7" }
                        }
                        Text {
                            anchors.centerIn: parent
                            visible: !Session.me.photo
                            text: (Session.me.name || "?").charAt(0).toUpperCase()
                            color: "#ffffff"; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.Bold
                        }
                        Avatar { anchors.fill: parent; photo: Session.me.photo; stamp: Session.meStamp }
                    }
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: Session.me.name || ""
                        color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.Medium
                    }
                }
                Row {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 4
                    Repeater {
                        model: [["lock", "lock", "Bloquear"], ["logout", "logout", "Cerrar sesión"], ["reboot", "restart", "Reiniciar"], ["poweroff", "power", "Apagar"]]
                        Item {
                            id: pb
                            required property var modelData
                            width: 38; height: 38
                            Rectangle {
                                anchors.fill: parent; radius: 10
                                color: pma.containsMouse ? (pb.modelData[0] === "poweroff" ? Theme.alpha(Theme.danger, 0.16) : Theme.hover) : "transparent"
                                Behavior on color { ColorAnimation { duration: Theme.ms(110) } }
                            }
                            LineIcon {
                                anchors.centerIn: parent
                                name: pb.modelData[1]; size: 18
                                color: pma.containsMouse && pb.modelData[0] === "poweroff" ? Theme.danger : Theme.text
                            }
                            Rectangle {   // its name, just above it while the pointer is there
                                visible: pma.containsMouse
                                anchors.horizontalCenter: parent.horizontalCenter
                                y: -height - 6
                                width: tip.implicitWidth + 16; height: 24; radius: 7
                                color: Theme.card2; border.color: Theme.border
                                Text { id: tip; anchors.centerIn: parent; text: pb.modelData[2]; color: Theme.text; font.family: Theme.font; font.pixelSize: 12 }
                            }
                            MouseArea { id: pma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: sm.power(pb.modelData[0]) }
                        }
                    }
                }
            }
        }
    }
}
