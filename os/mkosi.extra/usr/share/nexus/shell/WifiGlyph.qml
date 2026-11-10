import QtQuick
import QtQuick.Shapes

// Network indicator for the top bar: arcs over a dot (the concept's Wi-Fi mark). Offline: the arcs fade.
// `bars` (1–3, the Wi-Fi menu's signal strength): the arcs a weak signal does not reach are drawn faint, as on a Mac.
Item {
    id: g
    property color color: Theme.text
    property bool online: true
    property int bars: 3
    width: 18
    height: 14
    readonly property real cx: width / 2
    readonly property real cy: height - 1.8
    readonly property real sc: width / 18
    function tone(a) { return Qt.rgba(color.r, color.g, color.b, a) }
    Shape {
        anchors.fill: parent
        antialiasing: true
        ShapePath {
            strokeColor: g.tone(!g.online ? 0.3 : g.bars >= 3 ? 1 : 0.3); strokeWidth: 1.8 * g.sc; fillColor: "transparent"; capStyle: ShapePath.RoundCap
            PathAngleArc { centerX: g.cx; centerY: g.cy; radiusX: 11 * g.sc; radiusY: 11 * g.sc; startAngle: -135; sweepAngle: 90 }
        }
        ShapePath {
            strokeColor: g.tone(!g.online ? 0.3 : g.bars >= 2 ? 1 : 0.3); strokeWidth: 1.8 * g.sc; fillColor: "transparent"; capStyle: ShapePath.RoundCap
            PathAngleArc { centerX: g.cx; centerY: g.cy; radiusX: 6.6 * g.sc; radiusY: 6.6 * g.sc; startAngle: -135; sweepAngle: 90 }
        }
    }
    Rectangle {
        width: 3.8 * g.sc; height: width; radius: width / 2
        x: g.cx - width / 2; y: g.cy - height / 2
        color: g.color
    }
}
