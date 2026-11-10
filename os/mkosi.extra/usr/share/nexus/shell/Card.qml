import QtQuick

// Rounded surface used by the apps.
Rectangle {
    property string title: ""
    default property alias content: body.data
    radius: 16
    color: Theme.card
    border.color: Theme.border
    Text {
        id: head
        visible: parent.title !== ""
        x: 18; y: 14
        text: parent.title
        color: Theme.dim
        font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold; font.capitalization: Font.AllUppercase; font.letterSpacing: 1
    }
    Item { id: body; anchors.fill: parent; anchors.margins: 18; anchors.topMargin: parent.title !== "" ? 40 : 18 }
}
