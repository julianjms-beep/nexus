import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

// The NEXUS taskbar: the "barra" desktop (the look the person drew on 09-11 — the neon panther and one dark bar
// along the bottom, like Windows). Left: the panther, which opens the start menu. Middle: the apps as white line
// icons, a short accent line under the open ones (it pulses while one starts). Right: NEXUS AI's state and lock (network,
// battery and the clock are in the Mac-like menu bar, MenuBar.qml). Session.layout "clasico" brings back the top bar and the dock.
Window {
    id: bar
    visible: Session.layout === "barra"
    color: "transparent"
    height: 50
    LayerShell.Window.scope: "nexus-taskbar"
    LayerShell.Window.layer: LayerShell.Window.LayerTop
    LayerShell.Window.anchors: LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: 50
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityNone

    // "code" (VS Code) only while it is installed: nexus-sessiond leaves it out of Session.apps otherwise
    readonly property var pinned: ["terminal", "files", "browser", "editor", "code", "agents", "automations", "connect", "mail", "store", "monitor", "settings"]
        .filter(function(id) { return id !== "code" || !!Session.apps.code })
    readonly property var glyphs: ({ terminal: "terminal", files: "folder", browser: "globe", editor: "note", agents: "agents",
                                     automations: "bolt", connect: "link", store: "grid", mail: "mail", monitor: "pulse", settings: "gear", code: "code" })
    readonly property var sys: Session.system
    readonly property color ink: Theme.dark ? "#e9ecf5" : "#1a1f2e"
    readonly property color soft: Theme.dark ? Qt.rgba(1, 1, 1, 0.09) : Qt.rgba(0, 0, 0, 0.07)

    Rectangle {
        anchors.fill: parent
        color: Theme.dark ? Qt.rgba(0.027, 0.031, 0.047, 0.90) : Qt.rgba(0.97, 0.975, 0.99, 0.92)
        Rectangle { width: parent.width; height: 1; color: Theme.dark ? Qt.rgba(1, 1, 1, 0.07) : Qt.rgba(0, 0, 0, 0.08) }
    }

    // ---- left: the panther opens the start menu
    Item {
        id: start
        x: 8; width: 46; height: parent.height
        property bool down: false
        Rectangle {
            anchors.centerIn: parent
            width: 40; height: 40; radius: 20
            color: startMa.containsMouse ? bar.soft : "transparent"
            Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
        }
        Image {
            id: logo
            anchors.centerIn: parent
            width: 34; height: 34
            source: Qt.resolvedUrl("../icons/pantera-logo.png")
            sourceSize: Qt.size(68, 68)
            smooth: true; mipmap: true
            scale: start.down ? 0.9 : startMa.containsMouse ? 1.06 : 1
            Behavior on scale { NumberAnimation { duration: Theme.ms(160); easing.type: Easing.OutBack } }
        }
        Rectangle {   // a soft cyan ring while the pointer is on it
            anchors.centerIn: logo
            width: 38; height: 38; radius: 19
            color: "transparent"
            border.color: Theme.alpha("#3ff0ff", startMa.containsMouse ? 0.55 : 0)
            border.width: 1.5
            Behavior on border.color { ColorAnimation { duration: Theme.ms(160) } }
        }
        MouseArea {
            id: startMa
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onPressed: start.down = true
            onReleased: start.down = false
            onCanceled: start.down = false
            onClicked: Session.openPanel("start")
        }
    }

    // ---- middle: the apps, then NEXUS AI
    component TaskItem: Item {
        id: it
        property string glyph: ""
        property bool running: false
        property bool launches: true
        property bool launching: false
        signal clicked()
        width: 44; height: 44
        onRunningChanged: if (running) launching = false
        Timer { id: guard; interval: 6000; onTriggered: it.launching = false }
        Rectangle {
            anchors.fill: parent
            radius: 10
            color: ma.pressed ? Qt.rgba(bar.soft.r, bar.soft.g, bar.soft.b, bar.soft.a * 1.6) : ma.containsMouse ? bar.soft : "transparent"
            Behavior on color { ColorAnimation { duration: Theme.ms(120) } }
        }
        LineIcon {
            id: icon
            anchors.centerIn: parent
            anchors.verticalCenterOffset: -1 + lift
            property real lift: 0
            name: it.glyph
            size: 22
            stroke: 1.7
            color: bar.ink
            opacity: ma.containsMouse || it.running ? 1 : 0.86
            SequentialAnimation {
                id: bounce
                NumberAnimation { target: icon; property: "lift"; to: -4; duration: Theme.ms(110); easing.type: Easing.OutCubic }
                NumberAnimation { target: icon; property: "lift"; to: 0; duration: Theme.ms(260); easing.type: Easing.OutBack }
            }
        }
        Rectangle {   // open: a short accent line; starting: it pulses
            id: mark
            anchors.horizontalCenter: parent.horizontalCenter
            y: parent.height - 4
            height: 3; radius: 1.5
            width: it.running ? (ma.containsMouse ? 18 : 12) : it.launching ? 6 : 0
            color: Theme.accent
            opacity: it.running || it.launching ? 1 : 0
            Behavior on width { NumberAnimation { duration: Theme.ms(200); easing.type: Easing.OutCubic } }
            Behavior on opacity { NumberAnimation { duration: Theme.ms(160) } }
            SequentialAnimation on opacity {
                running: it.launching && !it.running
                loops: Animation.Infinite
                NumberAnimation { to: 0.25; duration: Theme.ms(380) }
                NumberAnimation { to: 1; duration: Theme.ms(380) }
            }
        }
        MouseArea {
            id: ma
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: { bounce.restart(); if (it.launches && !it.running) { it.launching = true; guard.restart() } it.clicked() }
        }
    }

    Row {
        anchors.centerIn: parent
        spacing: 4
        Repeater {
            model: bar.pinned
            TaskItem {
                required property string modelData
                glyph: bar.glyphs[modelData] || "grid"
                running: !!(Session.apps[modelData] || {}).running
                onClicked: Session.launch(modelData)
            }
        }
        Rectangle { width: 1; height: 22; anchors.verticalCenter: parent.verticalCenter; color: bar.soft }
        TaskItem {
            glyph: "brain"
            launches: false
            onClicked: Session.openPanel("ai")
        }
    }

    // ---- right: NEXUS AI's state, network/battery, date and time, lock
    component TrayButton: Item {
        id: tb
        default property alias content: inner.data
        signal clicked()
        width: inner.childrenRect.width + 20; height: 38
        anchors.verticalCenter: parent ? parent.verticalCenter : undefined
        Rectangle {
            anchors.fill: parent; radius: 9
            color: tma.containsMouse ? bar.soft : "transparent"
            Behavior on color { ColorAnimation { duration: Theme.ms(120) } }
        }
        Item { id: inner; x: 10; width: childrenRect.width; height: parent.height }
        MouseArea { id: tma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tb.clicked() }
    }

    Row {
        anchors.right: parent.right; anchors.rightMargin: 8
        anchors.verticalCenter: parent.verticalCenter
        spacing: 2

        TrayButton {
            onClicked: Session.aiConfigured || !Session.engineUp ? Session.openPanel("ai") : Session.openSettings("ai")
            Row {
                anchors.verticalCenter: parent.verticalCenter
                spacing: 7
                LineIcon {
                    anchors.verticalCenter: parent.verticalCenter
                    name: "broadcast"; size: 17; stroke: 1.7
                    color: !Session.engineUp ? Theme.danger : Session.aiConfigured ? bar.ink : Theme.warn
                }
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: !Session.engineUp ? "IA parada" : Session.aiConfigured ? "IA activa" : "IA sin clave"
                    color: !Session.engineUp ? Theme.danger : Session.aiConfigured ? bar.ink : Theme.warn
                    font.family: Theme.font; font.pixelSize: 13
                }
            }
        }
        // network, battery, quick settings and the clock are in the menu bar above (MenuBar.qml), as on a Mac
        TrayButton {
            onClicked: Session.openPanel("center")
            Item {
                anchors.verticalCenter: parent.verticalCenter
                width: 20; height: 20
                LineIcon { anchors.centerIn: parent; name: Session.prefs.dnd === true ? "bell-off" : "bell"; size: 17; stroke: 1.7; color: bar.ink }
                Rectangle {
                    visible: Session.unread > 0
                    x: 11; y: -2
                    width: Math.max(14, tbadge.implicitWidth + 7); height: 14; radius: 7
                    color: Theme.danger
                    Text { id: tbadge; anchors.centerIn: parent; text: Session.unread > 99 ? "99" : Session.unread; color: "#ffffff"; font.family: Theme.font; font.pixelSize: 9; font.weight: Font.Bold }
                }
            }
        }
        TrayButton {
            onClicked: Session.power("lock")
            LineIcon { anchors.verticalCenter: parent.verticalCenter; name: "lock"; size: 17; stroke: 1.7; color: bar.ink }
        }
    }
}
