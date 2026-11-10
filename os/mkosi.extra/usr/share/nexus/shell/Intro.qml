import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

// Start-up fade: the boot splash's picture (plymouth theme "nexus": same files, same place) opens up into the desktop.
Window {
    id: w
    // "reload": the shell restarted inside a running session (an update, a crash). Nothing covers the screen then: the
    // desktop's parts are simply made again over the person's open windows.
    readonly property bool reload: Qt.application.arguments.indexOf("reload") >= 0
    visible: !reload
    Component.onCompleted: if (reload) Qt.callLater(w.shown)
    color: "transparent"
    LayerShell.Window.scope: "nexus-intro"
    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityNone

    signal shown()                  // first frame on screen: Main.qml starts making the desktop underneath
    property bool seen: false
    onFrameSwapped: if (!seen) { seen = true; shown() }
    // opens once the desktop exists (Main.qml); never later than 6 s, so a broken part cannot leave it covering the screen
    function open() { if (!opening.running && visible) opening.start() }
    Timer { interval: 6000; running: !w.reload; onTriggered: w.open() }

    readonly property string art: "file:///usr/share/nexus/splash/"
    // The boot splash is drawn in physical pixels; with an interface size above 100 % one QML unit is k pixels, so every
    // size and offset is divided by k to land on exactly the same pixels. nexus-shell passes the real scale as
    // "scale=1.25" (Screen.devicePixelRatio is only the rounded-up integer on Wayland).
    readonly property real k: {
        var a = Qt.application.arguments
        for (var i = 0; i < a.length; i++) {
            var m = /^scale=([0-9.]+)$/.exec(String(a[i]))
            if (m && Number(m[1]) >= 1 && Number(m[1]) <= 4) return Number(m[1])
        }
        return 1
    }

    Item {
        id: scene
        anchors.fill: parent
        Rectangle {
            anchors.fill: parent
            gradient: Gradient {
                GradientStop { position: 0; color: "#06070d" }
                GradientStop { position: 1; color: "#090a16" }
            }
        }
        Image {
            id: mark
            source: w.art + "mark.png"
            x: w.width / 2 - 120 / w.k; y: w.height / 2 - (40 + 120) / w.k
            width: 240 / w.k; height: 240 / w.k
            sourceSize: Qt.size(240, 240)
            smooth: true
        }
        Image {
            id: word
            source: w.art + "word.png"
            width: sourceSize.width / w.k; height: sourceSize.height / w.k
            x: w.width / 2 - width / 2; y: w.height / 2 + 26 / w.k
            smooth: true
        }
        Row {
            id: dots
            x: w.width / 2 - (4 + 20) / w.k; y: w.height / 2 + 100 / w.k
            spacing: 12 / w.k
            Repeater {
                model: 3
                Image {
                    required property int index
                    source: w.art + "dot.png"
                    width: 8 / w.k; height: 8 / w.k
                    opacity: 0.25
                    SequentialAnimation on opacity {
                        loops: Animation.Infinite
                        PauseAnimation { duration: index * 110 }
                        NumberAnimation { to: 1; duration: 300; easing.type: Easing.OutQuad }
                        NumberAnimation { to: 0.25; duration: 420; easing.type: Easing.InQuad }
                        PauseAnimation { duration: (2 - index) * 110 }
                    }
                }
            }
        }
    }

    // hold the splash picture a moment (the desktop paints underneath), then open: the mark grows a little and
    // everything fades, revealing the desktop
    SequentialAnimation {
        id: opening
        PauseAnimation { duration: 450 }
        ParallelAnimation {
            NumberAnimation { target: scene; property: "opacity"; to: 0; duration: 650; easing.type: Easing.InOutCubic }
            NumberAnimation { target: mark; property: "scale"; to: 1.12; duration: 650; easing.type: Easing.OutCubic }
        }
        ScriptAction { script: w.visible = false }
    }
}
