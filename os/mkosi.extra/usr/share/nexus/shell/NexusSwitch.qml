import QtQuick

// NEXUS on/off switch: accent-coloured track when on, keyboard (Space/Enter) and click.
Item {
    id: sw
    property bool checked: false
    signal toggled()
    implicitWidth: 44; implicitHeight: 26
    activeFocusOnTab: true
    function flip() { checked = !checked; toggled() }
    Keys.onSpacePressed: flip()
    Keys.onReturnPressed: flip()

    Rectangle {
        anchors.fill: parent
        radius: height / 2
        color: sw.checked ? Theme.accent : Theme.alpha(Theme.text, 0.18)
        border.color: sw.activeFocus ? Theme.alpha(Theme.accent, 0.9) : "transparent"
        border.width: 2
        Behavior on color { ColorAnimation { duration: 140 } }
        Rectangle {
            width: parent.height - 6; height: width; radius: width / 2
            y: 3
            x: sw.checked ? parent.width - width - 3 : 3
            color: "#ffffff"
            Behavior on x { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
        }
    }
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { sw.forceActiveFocus(); sw.flip() } }
}
