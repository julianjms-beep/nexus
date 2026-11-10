import QtQuick

Rectangle {
    id: b
    default property alias content: holder.data
    property bool active: false
    signal clicked()
    implicitWidth: holder.width + 22
    implicitHeight: 32
    width: implicitWidth
    height: implicitHeight
    radius: 8
    color: area.pressed ? Theme.alpha(Theme.text, 0.14) : (area.containsMouse || active) ? Theme.hover : "transparent"
    Behavior on color { ColorAnimation { duration: 120 } }
    Item { id: holder; anchors.centerIn: parent; width: childrenRect.width; height: childrenRect.height }
    MouseArea { id: area; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: b.clicked() }
}
