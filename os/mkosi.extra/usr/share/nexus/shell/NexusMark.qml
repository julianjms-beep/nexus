import QtQuick

// The NEXUS mark. Spins while NEXUS AI is thinking.
Item {
    id: m
    property bool spinning: false
    width: 24
    height: 24
    Image {
        id: img
        anchors.fill: parent
        source: Qt.resolvedUrl("../icons/nexus.svg")
        sourceSize: Qt.size(Math.max(16, m.width * 2), Math.max(16, m.height * 2))
        smooth: true
        RotationAnimation on rotation { running: m.spinning; from: 0; to: 360; duration: 1300; loops: Animation.Infinite }
    }
    onSpinningChanged: if (!spinning) img.rotation = 0
}
