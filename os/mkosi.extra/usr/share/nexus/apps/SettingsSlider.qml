import QtQuick
import "../shell"

// A slider row (0–100) with an icon, a label and the value: brightness, volume.
Item {
    id: s
    property string icon: "sun"
    property string label: ""
    property int value: 50
    property bool enabled: true
    property string unit: "%"
    signal moved(int v)
    width: parent ? parent.width : 400
    height: 46
    opacity: enabled ? 1 : 0.45
    LineIcon { x: 0; anchors.verticalCenter: parent.verticalCenter; name: s.icon; size: 18; color: Theme.dim }
    Text { x: 30; anchors.verticalCenter: parent.verticalCenter; text: s.label; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
    Item {
        id: track
        x: 150; width: parent.width - 150 - 56; height: parent.height
        Rectangle { anchors.verticalCenter: parent.verticalCenter; width: parent.width; height: 6; radius: 3; color: Theme.alpha(Theme.text, 0.12) }
        Rectangle { anchors.verticalCenter: parent.verticalCenter; width: Math.max(6, parent.width * s.value / 100); height: 6; radius: 3; color: Theme.accent }
        Rectangle {
            x: Math.max(0, Math.min(parent.width - 20, parent.width * s.value / 100 - 10)); anchors.verticalCenter: parent.verticalCenter
            width: 20; height: 20; radius: 10; color: "#ffffff"; border.color: Theme.alpha("#000000", 0.15)
        }
        MouseArea {
            anchors.fill: parent; enabled: s.enabled; cursorShape: Qt.PointingHandCursor
            function at(mx) { return Math.max(0, Math.min(100, Math.round(mx / width * 100))) }
            onPressed: (m) => { s.value = at(m.x) }
            onPositionChanged: (m) => { if (pressed) s.value = at(m.x) }
            onReleased: (m) => { s.moved(at(m.x)) }
        }
    }
    Text { anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; text: s.value + s.unit; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.features: { "tnum": 1 } }
}
