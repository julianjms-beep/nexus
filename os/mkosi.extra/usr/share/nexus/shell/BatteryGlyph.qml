import QtQuick
import QtQuick.Shapes

// A Mac-style battery for the menu bar: an outline with its charge filled in, red at 10 % or less, a bolt while it
// charges. Session.system.battery (nexus-sessiond, /sys/class/power_supply) gives `percent` and `status`.
Item {
    id: b
    property real percent: 100
    property bool charging: false
    property color color: Theme.text
    readonly property color fill: percent <= 10 && !charging ? Theme.danger : color
    width: 26; height: 13

    Rectangle {   // the body
        id: body
        width: 23; height: 12; radius: 3.5
        anchors.verticalCenter: parent.verticalCenter
        color: "transparent"
        border.color: Qt.rgba(b.color.r, b.color.g, b.color.b, 0.55); border.width: 1
        Rectangle {   // the charge
            x: 2; y: 2; height: parent.height - 4; radius: 1.8
            width: Math.max(2, (parent.width - 4) * Math.max(0, Math.min(100, b.percent)) / 100)
            color: b.fill
        }
    }
    Rectangle {   // the cap
        x: body.width + 1; width: 2; height: 5; radius: 1
        anchors.verticalCenter: parent.verticalCenter
        color: Qt.rgba(b.color.r, b.color.g, b.color.b, 0.55)
    }
    Shape {   // charging: a bolt over the body, with a dark edge so it reads over the fill
        visible: b.charging
        anchors.centerIn: body
        width: 8; height: 11
        ShapePath {
            fillColor: b.color
            strokeColor: Theme.dark ? "#05060a" : "#ffffff"; strokeWidth: 1
            startX: 5; startY: 0
            PathLine { x: 0; y: 6.2 }
            PathLine { x: 3.6; y: 6.2 }
            PathLine { x: 2.8; y: 11 }
            PathLine { x: 8; y: 4.6 }
            PathLine { x: 4.4; y: 4.6 }
            PathLine { x: 5; y: 0 }
        }
    }
}
