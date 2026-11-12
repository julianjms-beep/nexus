import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

// Every window and every desktop at once (Súper+Tab, the taskbar's button, Ventana → Todas las ventanas), like
// Mission Control or Windows's task view. Top: the four desktops, the current one lit, each with how many windows it
// holds — click to go there. Below: the windows of the chosen desktop as cards (the app's icon, its title); click to
// bring one, × to close it, ①②③④ on a card to send it to another desktop, type to filter, ↑↓←→ and ↵ from the
// keyboard, Esc to leave. labwc 0.8 offers no live picture of a window, so the cards carry the icon and the title.
// The book of desktops and windows is nexus-sessiond's (Session.desktops).
Window {
    id: ov
    visible: false
    color: "transparent"
    LayerShell.Window.scope: "nexus-overview"
    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityExclusive

    property bool shown: false
    property int picked: 0       // the desktop whose windows are on screen (0 = the current one)
    property int sel: -1
    property string filter: ""
    function open() { hideLater.stop(); filter = ""; sel = -1; picked = 0; visible = true; shown = true; requestActivate(); keys.forceActiveFocus(); Session.refreshDesktops() }
    function close() { if (!shown) return; shown = false; hideLater.restart() }
    function toggle() { if (shown) close(); else open() }
    Timer { id: hideLater; interval: Theme.ms(200) + 10; onTriggered: if (!ov.shown) ov.visible = false }

    readonly property var d: Session.desktops
    readonly property int showing: picked > 0 ? picked : d.current
    function plain(t) { return String(t).toLowerCase().replace(/[áàä]/g, "a").replace(/[éèë]/g, "e").replace(/[íìï]/g, "i").replace(/[óòö]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n") }
    function onDesk(n) { return (d.windows || []).filter(function(w) { return w.desktop === n }) }
    readonly property var cards: {
        var q = plain(filter.trim())
        return onDesk(showing).filter(function(w) { return !q || plain(w.title).indexOf(q) >= 0 || plain(w.name).indexOf(q) >= 0 })
    }
    function go(w) { if (!w) return; Session.windowOp(w.line, "focus"); close() }
    function pickDesktop(n) { if (n === d.current) { picked = 0 } else { picked = n }; sel = -1 }
    function switchTo(n) { Session.goToDesktop(n); picked = 0; sel = -1 }

    // ---- the dimmed desktop behind, a click outside closes
    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0.02, 0.03, 0.06, Theme.dark ? 0.72 : 0.45)
        opacity: ov.shown ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: Theme.ms(ov.shown ? 200 : 160); easing.type: Easing.OutCubic } }
        MouseArea { anchors.fill: parent; onClicked: ov.close() }
    }

    Item {
        id: keys
        anchors.fill: parent
        focus: true
        Keys.onEscapePressed: ov.close()
        Keys.onReturnPressed: ov.go(ov.sel >= 0 && ov.sel < ov.cards.length ? ov.cards[ov.sel] : ov.cards[0])
        Keys.onEnterPressed: ov.go(ov.sel >= 0 && ov.sel < ov.cards.length ? ov.cards[ov.sel] : ov.cards[0])
        Keys.onRightPressed: if (ov.cards.length) ov.sel = Math.min(ov.sel + 1, ov.cards.length - 1)
        Keys.onLeftPressed: if (ov.cards.length) ov.sel = Math.max(ov.sel - 1, 0)
        Keys.onDownPressed: if (ov.cards.length) ov.sel = Math.min(ov.sel + grid.perRow, ov.cards.length - 1)
        Keys.onUpPressed: if (ov.cards.length) ov.sel = Math.max(ov.sel - grid.perRow, 0)
        Keys.onTabPressed: if (ov.cards.length) ov.sel = (ov.sel + 1) % ov.cards.length
        Keys.onPressed: (e) => {
            if (e.key === Qt.Key_Backspace) { ov.filter = ov.filter.slice(0, -1); ov.sel = -1; e.accepted = true }
            else if (e.key >= Qt.Key_1 && e.key <= Qt.Key_4 && (e.modifiers & Qt.ControlModifier)) { ov.switchTo(e.key - Qt.Key_0); e.accepted = true }
            else if (e.text && e.text.length === 1 && e.text >= " " && !(e.modifiers & Qt.ControlModifier)) { ov.filter += e.text; ov.sel = -1; e.accepted = true }
        }
    }

    // ---- everything comes in together: a slight growth and fade
    Item {
        id: stage
        anchors.fill: parent
        opacity: ov.shown ? 1 : 0
        scale: ov.shown ? 1 : 0.97
        transformOrigin: Item.Center
        Behavior on opacity { NumberAnimation { duration: Theme.ms(ov.shown ? 180 : 140); easing.type: Easing.OutCubic } }
        Behavior on scale { NumberAnimation { duration: Theme.ms(ov.shown ? 260 : 140); easing.type: Easing.OutCubic } }

        // the desktops, at the top
        Row {
            id: desks
            anchors.horizontalCenter: parent.horizontalCenter
            y: Session.layout === "barra" ? 62 : 86
            spacing: 14
            Repeater {
                model: ov.d.count
                Rectangle {
                    required property int index
                    readonly property int n: index + 1
                    readonly property bool current: n === ov.d.current
                    readonly property bool chosen: n === ov.showing
                    readonly property int count: ov.onDesk(n).length
                    width: 190; height: 112; radius: 14
                    color: chosen ? Theme.alpha(Theme.accent, 0.22) : dMa.containsMouse ? Qt.rgba(1, 1, 1, 0.10) : Qt.rgba(1, 1, 1, 0.06)
                    border.color: current ? Theme.accent : chosen ? Theme.alpha(Theme.accent, 0.6) : Qt.rgba(1, 1, 1, 0.14)
                    border.width: current ? 2 : 1
                    Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
                    // a tiny map of the windows on it
                    Flow {
                        x: 14; y: 14; width: parent.width - 28; spacing: 5
                        Repeater {
                            model: Math.min(count, 8)
                            Rectangle { width: 28; height: 20; radius: 4; color: Qt.rgba(1, 1, 1, 0.18); border.color: Qt.rgba(1, 1, 1, 0.25) }
                        }
                    }
                    Text {
                        x: 14; y: parent.height - 44
                        text: "Escritorio " + n
                        color: "#ffffff"; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold
                    }
                    Text {
                        x: 14; y: parent.height - 24
                        text: current ? (count === 1 ? "1 ventana · actual" : count + " ventanas · actual") : count === 0 ? "vacío" : count === 1 ? "1 ventana" : count + " ventanas"
                        color: Qt.rgba(1, 1, 1, 0.65); font.family: Theme.font; font.pixelSize: 11
                    }
                    MouseArea {
                        id: dMa
                        anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: ov.pickDesktop(n)
                        onDoubleClicked: { ov.switchTo(n); ov.close() }
                    }
                }
            }
        }
        // what the desktop row does
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            y: desks.y + desks.height + 10
            text: ov.showing === ov.d.current ? "Ventanas del escritorio " + ov.showing + " (el actual) · doble clic en un escritorio para ir a él · Súper+1…4" : "Ventanas del escritorio " + ov.showing + " · doble clic para ir a él"
            color: Qt.rgba(1, 1, 1, 0.5); font.family: Theme.font; font.pixelSize: 12
        }

        // the filter, when something was typed
        Rectangle {
            visible: ov.filter !== ""
            anchors.horizontalCenter: parent.horizontalCenter
            y: desks.y + desks.height + 36
            width: fText.implicitWidth + 36; height: 34; radius: 17
            color: Theme.alpha(Theme.accent, 0.25); border.color: Theme.alpha(Theme.accent, 0.6)
            Row {
                anchors.centerIn: parent; spacing: 8
                LineIcon { anchors.verticalCenter: parent.verticalCenter; name: "search"; size: 15; color: "#ffffff" }
                Text { id: fText; anchors.verticalCenter: parent.verticalCenter; text: ov.filter; color: "#ffffff"; font.family: Theme.font; font.pixelSize: 14 }
            }
        }

        // the windows
        Text {
            visible: ov.cards.length === 0
            anchors.centerIn: parent
            text: ov.filter ? "Ninguna ventana se llama así" : "No hay ventanas en este escritorio"
            color: Qt.rgba(1, 1, 1, 0.55); font.family: Theme.font; font.pixelSize: 16
        }
        Grid {
            id: grid
            readonly property int cardW: 300
            readonly property int perRow: Math.max(1, Math.min(4, Math.floor((ov.width - 80) / (cardW + 18))))
            anchors.horizontalCenter: parent.horizontalCenter
            y: desks.y + desks.height + 84
            columns: perRow
            spacing: 18
            Repeater {
                model: ov.cards
                Rectangle {
                    id: card
                    required property var modelData
                    required property int index
                    readonly property bool hot: index === ov.sel || cMa.containsMouse
                    width: grid.cardW; height: 150; radius: 16
                    color: hot ? Qt.rgba(1, 1, 1, 0.12) : Qt.rgba(1, 1, 1, 0.07)
                    border.color: modelData.focused ? Theme.accent : hot ? Qt.rgba(1, 1, 1, 0.35) : Qt.rgba(1, 1, 1, 0.14)
                    border.width: modelData.focused ? 2 : 1
                    scale: hot ? 1.03 : 1
                    Behavior on scale { NumberAnimation { duration: Theme.ms(140); easing.type: Easing.OutCubic } }
                    Behavior on color { ColorAnimation { duration: Theme.ms(120) } }
                    // the app's picture, large, like a window in the distance
                    Rectangle {
                        x: 18; y: 18; width: 64; height: 64; radius: 16
                        color: Theme.alpha(Theme.accent, 0.14)
                        AppIcon { visible: card.modelData.app !== ""; app: card.modelData.app; anchors.centerIn: parent; width: 48; height: 48 }
                        LineIcon { visible: card.modelData.app === ""; anchors.centerIn: parent; name: "grid"; size: 30; stroke: 1.5; color: "#ffffff" }
                    }
                    Text {
                        x: 98; y: 24; width: parent.width - 98 - 44
                        text: card.modelData.name
                        color: Qt.rgba(1, 1, 1, 0.65); font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold
                        elide: Text.ElideRight
                    }
                    Text {
                        x: 98; y: 44; width: parent.width - 98 - 44
                        text: card.modelData.title || card.modelData.name
                        color: "#ffffff"; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.Medium
                        wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight
                    }
                    MouseArea { id: cMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: ov.go(card.modelData) }
                    // close
                    Rectangle {
                        anchors.right: parent.right; anchors.rightMargin: 10; y: 10
                        width: 26; height: 26; radius: 13
                        visible: card.hot || xMa.containsMouse
                        color: xMa.containsMouse ? Theme.alpha(Theme.danger, 0.3) : Qt.rgba(1, 1, 1, 0.1)
                        LineIcon { anchors.centerIn: parent; name: "close"; size: 13; stroke: 2; color: xMa.containsMouse ? Theme.danger : "#ffffff" }
                        MouseArea { id: xMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.windowOp(card.modelData.line, "close") }
                    }
                    // send to another desktop
                    Row {
                        x: 18; y: parent.height - 40
                        spacing: 6
                        visible: card.hot
                        Text { anchors.verticalCenter: parent.verticalCenter; text: "Mover a"; color: Qt.rgba(1, 1, 1, 0.55); font.family: Theme.font; font.pixelSize: 11 }
                        Repeater {
                            model: ov.d.count
                            Rectangle {
                                required property int index
                                readonly property int n: index + 1
                                readonly property bool here: n === card.modelData.desktop
                                width: 24; height: 24; radius: 12
                                color: here ? Theme.alpha(Theme.accent, 0.4) : mMa.containsMouse ? Qt.rgba(1, 1, 1, 0.25) : Qt.rgba(1, 1, 1, 0.1)
                                border.color: here ? Theme.accent : "transparent"
                                Text { anchors.centerIn: parent; text: n; color: "#ffffff"; font.family: Theme.font; font.pixelSize: 11; font.weight: Font.DemiBold }
                                MouseArea { id: mMa; anchors.fill: parent; hoverEnabled: true; cursorShape: here ? Qt.ArrowCursor : Qt.PointingHandCursor; onClicked: if (!here) Session.windowOp(card.modelData.line, "move", n) }
                            }
                        }
                    }
                }
            }
        }
        // the keys, at the bottom
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            y: parent.height - (Session.layout === "barra" ? 50 : 0) - 34
            text: "escribe para filtrar  ·  ↑↓←→ elegir  ·  ↵ ir a la ventana  ·  Ctrl+1…4 cambiar de escritorio  ·  esc cerrar"
            color: Qt.rgba(1, 1, 1, 0.45); font.family: Theme.font; font.pixelSize: 12
        }
    }
}
