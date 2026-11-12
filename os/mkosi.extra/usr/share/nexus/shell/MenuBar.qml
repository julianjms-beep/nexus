import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell
import "menus.js" as Menus

// The menu bar of the "barra" desktop (the person asked on 09-11 for "algo así arriba como en Apple"): on the left the
// NEXUS menu, the active app's name in bold and that app's menus (menus.js); on the right NEXUS AI, battery, network,
// quick settings and the date and time. An open menu is drawn by `pop`, an overlay over the whole screen: a click
// anywhere else closes it and moving the pointer along the bar opens the next menu, as on a Mac. The menu items press
// the app's own shortcuts in its window, or act on the window, through nexus-sessiond (the active window never loses
// the keyboard: neither surface takes it).
Window {
    id: mb
    visible: Session.layout === "barra"
    color: "transparent"
    height: 30
    LayerShell.Window.scope: "nexus-menubar"
    LayerShell.Window.layer: LayerShell.Window.LayerTop
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: 30
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityNone

    readonly property var f: Session.focused || ({})
    readonly property bool desktop: !f.name
    readonly property string appName: desktop ? "Escritorio" : f.name
    // [0] the NEXUS menu (the logo), [1] the app's name, then its menus — each {title, items}
    readonly property var menus: [{ title: "", items: Menus.systemMenu() }, { title: appName, items: Menus.appMenu(appName, desktop) }]
        .concat(Menus.forApp(f.app || "", f.name || ""))
    readonly property color ink: Theme.dark ? "#f2f4fa" : "#161a26"
    readonly property var sys: Session.system
    property int open: -1

    function openMenu(i) { open = i; pop.visible = true }
    function closeMenu() { open = -1; pop.visible = false }
    onMenusChanged: if (open >= menus.length) closeMenu()
    onVisibleChanged: if (!visible) closeMenu()

    // an item runs a moment after its menu has gone, so the shortcut lands in the app's window, not on the menu
    property var pending: null
    function run(item) { closeMenu(); pending = item; runLater.restart() }
    Timer { id: runLater; interval: 90; onTriggered: { var it = mb.pending; mb.pending = null; if (it) mb.perform(it) } }
    function perform(it) {
        if (it.keys) Session.sendKeys(it.keys)
        else if (it.win) Session.windowAction(it.win)
        else if (it.act) {
            var a = it.act
            if (a.launch) Session.launch(a.launch)
            else if (a.settings) Session.openSettings(a.settings)
            else if (a.panel) Session.openPanel(a.panel)
            else if (a.ask) Session.prefillRequested(a.ask)
            else if (a.wallpaper) Session.nextWallpaper()
            else if (a.power) { if (a.power === "lock") Session.power("lock"); else Session.askLocalConfirm(a.power) }
        }
    }

    Rectangle {
        anchors.fill: parent
        color: Theme.dark ? Qt.rgba(0.02, 0.024, 0.04, 0.66) : Qt.rgba(0.97, 0.975, 0.99, 0.76)
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.dark ? Qt.rgba(1, 1, 1, 0.06) : Qt.rgba(0, 0, 0, 0.07) }
    }

    // ---- left: the NEXUS menu, the app's name, its menus
    Row {
        id: titles
        x: 8; height: parent.height
        Repeater {
            id: titleRep
            model: mb.menus
            Item {
                id: t
                required property var modelData
                required property int index
                width: index === 0 ? 38 : label.implicitWidth + 22
                height: titles.height
                Rectangle {
                    anchors.fill: parent; anchors.topMargin: 3; anchors.bottomMargin: 3
                    radius: 6
                    color: mb.open === t.index ? Qt.rgba(mb.ink.r, mb.ink.g, mb.ink.b, 0.17)
                         : tma.containsMouse ? Qt.rgba(mb.ink.r, mb.ink.g, mb.ink.b, 0.08) : "transparent"
                }
                Image {
                    visible: t.index === 0
                    anchors.centerIn: parent
                    width: 20; height: 20
                    source: Qt.resolvedUrl("../icons/pantera-logo.png")
                    sourceSize: Qt.size(40, 40)
                    smooth: true; mipmap: true
                }
                Text {
                    id: label
                    visible: t.index > 0
                    anchors.centerIn: parent
                    text: t.modelData.title
                    color: mb.ink
                    font.family: Theme.font; font.pixelSize: 14
                    font.weight: t.index === 1 ? Font.Bold : Font.Normal
                }
                MouseArea { id: tma; anchors.fill: parent; hoverEnabled: true; onClicked: mb.open === t.index ? mb.closeMenu() : mb.openMenu(t.index) }
            }
        }
    }

    // ---- right: NEXUS AI, battery, network, quick settings, date and time
    component Status: Item {
        id: st
        default property alias content: box.data
        signal clicked()
        width: box.childrenRect.width + 16; height: mb.height
        Rectangle {
            anchors.fill: parent; anchors.topMargin: 3; anchors.bottomMargin: 3; radius: 6
            color: sma.containsMouse ? Qt.rgba(mb.ink.r, mb.ink.g, mb.ink.b, 0.08) : "transparent"
        }
        Item { id: box; x: 8; width: childrenRect.width; height: parent.height }
        MouseArea { id: sma; anchors.fill: parent; hoverEnabled: true; onClicked: st.clicked() }
    }
    // a click on the bar while the Wi-Fi, battery, Control Center or clock menu is open (that menu covers the screen):
    // another of those icons opens its menu in place, an app menu opens; anything else just closes the open one
    function hitStatus(x, y) {
        if (!mb.visible || y >= mb.height) return false
        var all = [aiS, power, wifiS, ccS, bellS, clockS]
        for (var i = 0; i < all.length; i++) {
            var p = all[i].mapToItem(null, 0, 0)
            if (x >= p.x && x < p.x + all[i].width) { all[i].clicked(); return true }
        }
        var t = pop.titleAt(x)
        if (t >= 0) openMenu(t)
        return false
    }
    Component.onCompleted: Session.statusHit = function(x, y) { return mb.hitStatus(x, y) }

    Row {
        anchors.right: parent.right; anchors.rightMargin: 8
        height: parent.height
        Status {
            id: aiS
            onClicked: Session.aiConfigured || !Session.engineUp ? Session.openPanel("ai") : Session.openSettings("ai")
            LineIcon {
                anchors.verticalCenter: parent.verticalCenter
                name: "brain"; size: 17; stroke: 1.7
                color: !Session.engineUp ? Theme.danger : Session.aiConfigured ? mb.ink : Theme.warn
            }
        }
        // the battery as on a Mac ("73 %" and the battery); a computer without one (a desktop PC, a virtual machine)
        // shows a plug: it runs on mains power
        Status {
            id: power
            readonly property var bat: mb.sys ? mb.sys.battery : null
            onClicked: Session.openPanelAt("battery", power)
            Row {
                anchors.verticalCenter: parent.verticalCenter
                spacing: 6
                Text {
                    visible: !!power.bat
                    anchors.verticalCenter: parent.verticalCenter
                    text: power.bat ? power.bat.percent + " %" : ""
                    color: mb.ink
                    font.family: Theme.font; font.pixelSize: 13
                    font.features: { "tnum": 1 }
                }
                BatteryGlyph {
                    visible: !!power.bat
                    anchors.verticalCenter: parent.verticalCenter
                    percent: power.bat ? power.bat.percent : 0
                    charging: !!power.bat && (power.bat.status === "Charging" || power.bat.status === "Full")
                    color: mb.ink
                }
                LineIcon {
                    visible: !power.bat
                    anchors.verticalCenter: parent.verticalCenter
                    name: "plug"; size: 16; stroke: 1.7; color: mb.ink
                }
            }
        }
        Status {
            id: wifiS
            onClicked: Session.openPanelAt("wifi", wifiS)
            WifiGlyph {
                anchors.verticalCenter: parent.verticalCenter
                online: !!(mb.sys && mb.sys.online)
                color: online ? mb.ink : Theme.warn
            }
        }
        Status {
            id: ccS
            onClicked: Session.openPanelAt("quick", ccS)
            LineIcon { anchors.verticalCenter: parent.verticalCenter; name: "sliders"; size: 17; stroke: 1.6; color: mb.ink }
        }
        Status {
            id: bellS
            onClicked: Session.openPanel("center")
            Item {
                anchors.verticalCenter: parent.verticalCenter
                width: 20; height: 20
                LineIcon { anchors.centerIn: parent; name: Session.prefs.dnd === true ? "bell-off" : "bell"; size: 17; stroke: 1.7; color: mb.ink }
                Rectangle {
                    visible: Session.unread > 0 && Session.prefs.dnd !== true
                    x: 11; y: -2
                    width: Math.max(14, badge.implicitWidth + 7); height: 14; radius: 7
                    color: Theme.danger
                    Text { id: badge; anchors.centerIn: parent; text: Session.unread > 99 ? "99" : Session.unread; color: "#ffffff"; font.family: Theme.font; font.pixelSize: 9; font.weight: Font.Bold }
                }
            }
        }
        Status {
            id: clockS
            onClicked: Session.openPanelAt("notices", clockS)
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: {
                    var d = Session.now.toLocaleDateString(Qt.locale("es_ES"), "ddd d MMM").replace(/\./g, "")
                    return d.charAt(0).toUpperCase() + d.slice(1) + "   " + Qt.formatTime(Session.now, Session.clock24 ? "HH:mm" : "h:mm AP")
                }
                color: mb.ink
                font.family: Theme.font; font.pixelSize: 14
                font.features: { "tnum": 1 }
            }
        }
    }

    // ---- an open menu
    Window {
        id: pop
        visible: false
        color: "transparent"
        LayerShell.Window.scope: "nexus-menu"
        LayerShell.Window.layer: LayerShell.Window.LayerOverlay
        LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
        LayerShell.Window.exclusionZone: -1
        LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityNone

        function titleAt(x) {
            for (var i = 0; i < mb.menus.length; i++) {
                var it = titleRep.itemAt(i)
                if (it && x >= titles.x + it.x && x < titles.x + it.x + it.width) return i
            }
            return -1
        }
        // the bar stays usable under the overlay: moving along it opens the menu under the pointer
        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onPositionChanged: (m) => { if (m.y < mb.height) { var i = pop.titleAt(m.x); if (i >= 0 && i !== mb.open) mb.open = i } }
            onClicked: (m) => {
                if (m.y < mb.height) { var i = pop.titleAt(m.x); if (i >= 0 && i !== mb.open) { mb.open = i; return } }
                mb.closeMenu()
            }
        }
        TextMetrics { id: tm; font.family: Theme.font; font.pixelSize: 14 }
        Rectangle {
            id: card
            readonly property var cur: mb.open >= 0 && mb.open < mb.menus.length ? mb.menus[mb.open] : null
            visible: !!cur
            // as wide as its longest line: measured once per menu (not in a binding); the overlay may still have no size
            // when a menu opens, so the screen's width only limits it afterwards
            property real need: 220
            onCurChanged: {
                var w = 220
                if (cur) for (var i = 0; i < cur.items.length; i++) {
                    var it = cur.items[i]; if (it.sep) continue
                    tm.text = it.label; var lw = tm.advanceWidth
                    tm.text = Menus.pretty(it.keys || it.hint || ""); w = Math.max(w, lw + (tm.text ? tm.advanceWidth + 52 : 0) + 40)
                }
                need = Math.ceil(w)
            }
            width: Math.min(need, Math.max(220, pop.width - 12))
            readonly property var anchorItem: mb.open >= 0 ? titleRep.itemAt(mb.open) : null
            x: Math.max(6, Math.min(pop.width - width - 6, titles.x + (anchorItem ? anchorItem.x : 0)))
            y: mb.height + 2
            height: list.height + 12
            radius: 10
            color: Theme.dark ? Qt.rgba(0.075, 0.085, 0.115, 0.97) : Qt.rgba(0.99, 0.99, 1, 0.98)
            border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.09) : Qt.rgba(0, 0, 0, 0.1)
            MouseArea { anchors.fill: parent }   // a click on a separator or the padding keeps it open
            Column {
                id: list
                x: 6; y: 6
                width: parent.width - 12
                Repeater {
                    model: card.cur ? card.cur.items : []
                    Item {
                        id: row
                        required property var modelData
                        width: list.width
                        height: modelData.sep ? 9 : 26
                        Rectangle { visible: !!row.modelData.sep; anchors.centerIn: parent; width: parent.width - 16; height: 1; color: Theme.border }
                        Rectangle {
                            visible: !row.modelData.sep
                            anchors.fill: parent; radius: 5
                            color: rma.containsMouse ? Theme.accent : "transparent"
                        }
                        Text {
                            visible: !row.modelData.sep
                            x: 12; anchors.verticalCenter: parent.verticalCenter
                            text: row.modelData.label || ""
                            color: rma.containsMouse ? "#ffffff" : Theme.text
                            font.family: Theme.font; font.pixelSize: 14
                        }
                        Text {
                            visible: !row.modelData.sep && text !== ""
                            anchors.right: parent.right; anchors.rightMargin: 12; anchors.verticalCenter: parent.verticalCenter
                            text: Menus.pretty(row.modelData.keys || row.modelData.hint || "")
                            color: rma.containsMouse ? Qt.rgba(1, 1, 1, 0.8) : Theme.faint
                            font.family: Theme.font; font.pixelSize: 13
                        }
                        MouseArea { id: rma; anchors.fill: parent; enabled: !row.modelData.sep; hoverEnabled: true; onClicked: mb.run(row.modelData) }
                    }
                }
            }
        }
    }
}
