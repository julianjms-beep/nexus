import QtQuick

Item {
    id: it
    property url icon
    property string label
    property bool running: false
    // clicked and not running yet: the dot pulses until the app's window is up (or for 6 s, if it never comes)
    property bool launching: false
    property bool launches: true       // false for NEXUS AI: it opens a panel, not an app
    onRunningChanged: if (running) launching = false
    Timer { id: launchGuard; interval: 6000; onTriggered: it.launching = false }
    signal clicked()
    width: 72
    height: 72
    Image {
        id: img
        anchors.centerIn: parent
        width: 62; height: 62
        source: it.icon
        sourceSize: Qt.size(124, 124)
        smooth: true; mipmap: true
        scale: area.pressed ? 0.9 : area.containsMouse ? 1.12 : 1.0
        Behavior on scale { NumberAnimation { duration: Theme.ms(160); easing.type: Easing.OutCubic } }
        transform: Translate { id: lift }
    }
    Rectangle {
        id: dot
        readonly property bool on: it.running || it.launching
        width: 5; height: 5; radius: 2.5
        color: Theme.text
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.bottom
        anchors.topMargin: 1
        scale: on ? 1 : 0
        visible: scale > 0
        Behavior on scale { NumberAnimation { duration: Theme.ms(240); easing.type: Easing.OutBack } }
        property real pulse: 1
        opacity: it.launching && !it.running ? pulse : 1
        SequentialAnimation on pulse {
            running: it.launching && !it.running && Theme.motion
            loops: Animation.Infinite
            NumberAnimation { to: 0.25; duration: 380; easing.type: Easing.InOutSine }
            NumberAnimation { to: 1; duration: 380; easing.type: Easing.InOutSine }
        }
    }
    Rectangle {
        opacity: area.containsMouse ? 1 : 0
        visible: opacity > 0
        Behavior on opacity { NumberAnimation { duration: Theme.ms(120) } }
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.top
        anchors.bottomMargin: 14
        width: tip.implicitWidth + 18; height: 24; radius: 7
        color: Theme.card; border.color: Theme.border
        Text { id: tip; anchors.centerIn: parent; text: it.label; color: Theme.text; font.family: Theme.font; font.pixelSize: 12 }
    }
    SequentialAnimation {
        id: bounce
        NumberAnimation { target: lift; property: "y"; to: -14; duration: Theme.ms(160); easing.type: Easing.OutQuad }
        NumberAnimation { target: lift; property: "y"; to: 0; duration: Theme.ms(260); easing.type: Easing.OutBounce }
    }
    MouseArea {
        id: area
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: { bounce.restart(); if (it.launches && !it.running) { it.launching = true; launchGuard.restart() } it.clicked() }
    }
}
