import QtQuick
import "../shell"

// A card of a settings page: a title, an optional line under it, and whatever rows it holds (default content).
Rectangle {
    id: card
    property string title: ""
    property string note: ""
    default property alias content: body.data
    width: parent ? parent.width : 400
    height: body.y + body.childrenRect.height + 18
    radius: 16
    color: Theme.card
    border.color: Theme.border
    Text { id: t; visible: card.title !== ""; x: 18; y: 16; text: card.title; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold }
    Text { id: n; visible: card.note !== ""; x: 18; y: t.visible ? 38 : 16; width: parent.width - 36; wrapMode: Text.Wrap; text: card.note; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; lineHeight: 1.2 }
    Column { id: body; x: 18; y: (n.visible ? n.y + n.height : t.visible ? 42 : 16) + 6; width: parent.width - 36; spacing: 8 }
}
