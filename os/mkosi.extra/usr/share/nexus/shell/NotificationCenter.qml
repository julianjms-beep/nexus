import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

// The notification centre: every notice NEXUS showed (and the ones No molestar kept quiet), newest first, grouped by
// day, with the app's icon. The bell in the bar opens it (Súper+N too); a notice is read when the centre shows it; ×
// deletes one, «Borrar todo» empties it. nexus-sessiond keeps them on disk (core/src/notices.ts). The card slides in
// from the right edge, under the bar, like macOS's centre and Windows's.
Window {
    id: nc
    visible: false
    color: "transparent"
    LayerShell.Window.scope: "nexus-center"
    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityExclusive

    property bool shown: false
    function open() { hideLater.stop(); visible = true; shown = true; requestActivate(); card.forceActiveFocus(); Session.refreshNotices(); markSoon.restart() }
    function close() { if (!shown) return; shown = false; hideLater.restart() }
    function toggle() { if (shown) close(); else open() }
    Timer { id: hideLater; interval: Theme.ms(220) + 10; onTriggered: if (!nc.shown) nc.visible = false }
    // what the person has in front of them counts as read (after a moment, so the badge is seen going away)
    Timer { id: markSoon; interval: 1200; onTriggered: if (nc.shown && Session.unread > 0) Session.readNotices() }

    readonly property var glyphs: ({ terminal: "terminal", files: "folder", browser: "globe", editor: "note", agents: "agents", automations: "bolt",
                                     connect: "link", store: "grid", mail: "mail", monitor: "pulse", settings: "gear", code: "code", update: "update", ai: "brain", security: "shield" })
    function glyphOf(n) { return glyphs[n.app] || (n.kind === "warn" ? "info" : "sparkle") }
    function nameOf(n) { var a = Session.apps[n.app]; return a ? a.name : (n.app === "update" ? "NEXUS Update" : n.app === "ai" ? "NEXUS AI" : n.app === "security" ? "NEXUS Guard" : n.app || "NEXUS") }
    function dayOf(iso) {
        var d = new Date(iso), t = new Date(), y = new Date(t.getTime() - 86400000)
        if (d.toDateString() === t.toDateString()) return "Hoy"
        if (d.toDateString() === y.toDateString()) return "Ayer"
        var s = d.toLocaleDateString(Qt.locale("es_ES"), "dddd d 'de' MMMM"); return s.charAt(0).toUpperCase() + s.slice(1)
    }
    function timeOf(iso) { return new Date(iso).toLocaleTimeString(Qt.locale("es_ES"), "HH:mm") }
    // the list with a day header before the first notice of each day
    readonly property var rows: {
        var out = [], last = ""
        for (var i = 0; i < Session.notices.length; i++) {
            var n = Session.notices[i], d = dayOf(n.at)
            if (d !== last) { out.push({ header: d }); last = d }
            out.push(n)
        }
        return out
    }

    MouseArea {
        anchors.fill: parent
        onClicked: (m) => { if (Session.statusHit && Session.statusHit(m.x, m.y)) return; nc.close() }
    }

    Rectangle {
        id: card
        width: Math.min(400, nc.width - 20)
        readonly property real topY: Session.layout === "barra" ? 34 : 60
        y: topY
        height: nc.height - topY - (Session.layout === "barra" ? 50 + 10 : 10)
        x: nc.width - width - 10 + dx
        property real dx: nc.shown ? 0 : width + 20
        radius: 16
        color: Theme.dark ? Qt.rgba(0.1, 0.11, 0.145, 0.97) : Qt.rgba(0.955, 0.96, 0.975, 0.98)
        border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.12) : Qt.rgba(0, 0, 0, 0.12)
        clip: true
        focus: true
        Keys.onEscapePressed: nc.close()
        Behavior on dx { NumberAnimation { duration: Theme.ms(nc.shown ? 260 : 200); easing.type: Easing.OutCubic } }
        MouseArea { anchors.fill: parent }

        // ---- header: Avisos · n sin leer · No molestar · Borrar todo
        Item {
            id: head
            x: 18; y: 16; width: parent.width - 36; height: 58
            Text { y: 0; text: "Avisos"; color: Theme.text; font.family: Theme.font; font.pixelSize: 20; font.weight: Font.Bold }
            Text {
                y: 38; width: parent.width; elide: Text.ElideRight
                text: Session.prefs.dnd === true ? "No molestar: los avisos llegan aquí sin sonar" : Session.unread > 0 ? Session.unread + (Session.unread === 1 ? " sin leer" : " sin leer") : Session.notices.length ? "Todo leído" : "Nada pendiente"
                color: Theme.dim; font.family: Theme.font; font.pixelSize: 12
            }
            Row {
                anchors.right: parent.right; y: 2
                spacing: 6
                Rectangle {
                    width: dndT.implicitWidth + 24; height: 30; radius: 15
                    readonly property bool on: Session.prefs.dnd === true
                    color: on ? Theme.alpha(Theme.accent, 0.22) : dndMa.containsMouse ? Theme.hover : "transparent"
                    border.color: on ? Theme.alpha(Theme.accent, 0.6) : Theme.border
                    Row {
                        anchors.centerIn: parent; spacing: 6
                        LineIcon { anchors.verticalCenter: parent.verticalCenter; name: "moon"; size: 14; color: parent.parent.on ? Theme.accent : Theme.dim }
                        Text { id: dndT; anchors.verticalCenter: parent.verticalCenter; text: "No molestar"; color: parent.parent.on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold }
                    }
                    MouseArea { id: dndMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("dnd", Session.prefs.dnd !== true) }
                }
                Rectangle {
                    visible: Session.notices.length > 0
                    width: clrT.implicitWidth + 24; height: 30; radius: 15
                    color: clrMa.containsMouse ? Theme.hover : "transparent"
                    border.color: Theme.border
                    Text { id: clrT; anchors.centerIn: parent; text: "Borrar todo"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold }
                    MouseArea { id: clrMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.clearRecent() }
                }
            }
        }

        // ---- nothing yet
        Column {
            visible: Session.notices.length === 0
            anchors.centerIn: parent
            spacing: 10
            LineIcon { anchors.horizontalCenter: parent.horizontalCenter; name: "bell"; size: 36; stroke: 1.4; color: Theme.faint }
            Text { anchors.horizontalCenter: parent.horizontalCenter; text: "No hay avisos"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
            Text { anchors.horizontalCenter: parent.horizontalCenter; width: 260; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.Wrap; text: "Aquí quedan las actualizaciones, lo que termina NEXUS AI, el correo de tus contactos importantes y los agentes que esperan tu clic."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; lineHeight: 1.2 }
        }

        // ---- the list
        ListView {
            id: list
            x: 12; y: head.y + head.height + 6
            width: parent.width - 24; height: parent.height - y - 12
            clip: true
            spacing: 6
            model: nc.rows
            boundsBehavior: Flickable.StopAtBounds
            delegate: Item {
                id: row
                required property var modelData
                readonly property bool isHeader: modelData.header !== undefined
                width: list.width
                height: isHeader ? 30 : tile.height
                Text {
                    visible: row.isHeader
                    x: 6; y: 9
                    text: row.isHeader ? modelData.header : ""
                    color: Theme.accent; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold
                }
                Rectangle {
                    id: tile
                    visible: !row.isHeader
                    width: parent.width
                    height: body.y + body.height + 12
                    radius: 12
                    color: tma.containsMouse ? Theme.hover : (Theme.dark ? Qt.rgba(1, 1, 1, 0.04) : Qt.rgba(0, 0, 0, 0.03))
                    border.color: !row.isHeader && !modelData.read ? Theme.alpha(Theme.accent, 0.35) : Theme.border
                    Rectangle {
                        x: 12; y: 12; width: 34; height: 34; radius: 10
                        color: Theme.alpha(row.isHeader ? Theme.accent : modelData.kind === "warn" ? Theme.warn : modelData.kind === "good" ? Theme.good : Theme.accent, 0.16)
                        LineIcon { anchors.centerIn: parent; name: row.isHeader ? "bell" : nc.glyphOf(modelData); size: 18; stroke: 1.7; color: row.isHeader ? Theme.accent : modelData.kind === "warn" ? Theme.warn : modelData.kind === "good" ? Theme.good : Theme.accent }
                    }
                    Text {
                        id: who
                        x: 56; y: 11; width: parent.width - 56 - 70
                        elide: Text.ElideRight
                        text: row.isHeader ? "" : nc.nameOf(modelData) + (modelData.title ? " · " + modelData.title : "")
                        color: Theme.text; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold
                    }
                    Text {
                        anchors.right: parent.right; anchors.rightMargin: 34; y: 11
                        text: row.isHeader ? "" : nc.timeOf(modelData.at)
                        color: Theme.faint; font.family: Theme.font; font.pixelSize: 11
                    }
                    Text {
                        id: body
                        x: 56; y: who.y + who.height + 3; width: parent.width - 56 - 16
                        text: row.isHeader ? "" : modelData.text
                        wrapMode: Text.Wrap; maximumLineCount: 4; elide: Text.ElideRight
                        color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.18
                    }
                    Rectangle {
                        visible: !row.isHeader && !modelData.read
                        x: 46; y: 10; width: 8; height: 8; radius: 4; color: Theme.accent
                    }
                    MouseArea { id: tma; anchors.fill: parent; hoverEnabled: true; onClicked: if (!row.isHeader && !modelData.read) Session.readNotices(modelData.id) }
                    Rectangle {
                        anchors.right: parent.right; anchors.rightMargin: 8; y: 8
                        width: 22; height: 22; radius: 11
                        visible: tma.containsMouse || xma.containsMouse
                        color: xma.containsMouse ? Theme.alpha(Theme.danger, 0.2) : "transparent"
                        LineIcon { anchors.centerIn: parent; name: "close"; size: 12; stroke: 2; color: xma.containsMouse ? Theme.danger : Theme.dim }
                        MouseArea { id: xma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: if (!row.isHeader) Session.deleteNotice(modelData.id) }
                    }
                }
            }
        }
    }
}
