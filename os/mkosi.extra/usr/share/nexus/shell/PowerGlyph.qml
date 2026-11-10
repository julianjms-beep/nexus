import QtQuick
import QtQuick.Shapes

Item {
    id: g
    property color color: Theme.text
    width: 14
    height: 14
    Shape {
        anchors.fill: parent
        antialiasing: true
        ShapePath {
            strokeColor: g.color; strokeWidth: 1.8; fillColor: "transparent"; capStyle: ShapePath.RoundCap
            PathAngleArc { centerX: g.width / 2; centerY: g.height / 2 + 0.8; radiusX: g.width / 2 - 1.5; radiusY: g.height / 2 - 1.5; startAngle: -55; sweepAngle: 290 }
        }
        ShapePath {
            strokeColor: g.color; strokeWidth: 1.8; fillColor: "transparent"; capStyle: ShapePath.RoundCap
            startX: g.width / 2; startY: 1
            PathLine { x: g.width / 2; y: g.height / 2 }
        }
    }
}
