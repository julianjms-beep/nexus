import QtQuick
import QtQuick.Effects

// The person's picture (Ajustes → Cuenta), round, over whatever sits behind (the letter in a gradient circle stays
// when there is no picture). `stamp` changes when the picture does, so the same file name reloads.
Item {
    id: av
    property string photo: ""
    property int stamp: 0
    visible: photo !== ""
    Image {
        id: img
        anchors.fill: parent
        source: av.photo ? "file://" + av.photo + "?v=" + av.stamp : ""
        fillMode: Image.PreserveAspectCrop
        sourceSize: Qt.size(Math.max(64, width * 2), Math.max(64, height * 2))
        asynchronous: true
        visible: false
    }
    Rectangle { id: disc; anchors.fill: parent; radius: width / 2; color: "#ffffff"; visible: false; layer.enabled: true }
    MultiEffect {
        anchors.fill: parent
        source: img
        maskEnabled: true
        maskSource: disc
        maskThresholdMin: 0.5
        maskSpreadAtMin: 1.0
    }
}
