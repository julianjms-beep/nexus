import QtQuick

// Desktop widget: weather now for the chosen city (Open-Meteo via nexus-sessiond). Hidden when off or unknown.
Rectangle {
    id: card
    property var wx: Session.weather
    visible: wx !== null
    width: 300; height: 112
    radius: 20
    color: Theme.glass   // glass over the wallpaper
    Behavior on color { ColorAnimation { duration: Theme.ms(500) } }
    border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.13) : Theme.border

    // NEXUS weather icon (icons/weather-<glyph>.svg, os/art/make-weather-icons.py); the emoji only if there is none
    Item {
        id: icon
        x: 18; anchors.verticalCenter: parent.verticalCenter
        width: 60; height: 60
        Image {
            id: glyph
            anchors.fill: parent
            source: card.wx && card.wx.glyph ? Qt.resolvedUrl("../icons/weather-" + card.wx.glyph + ".svg") : ""
            sourceSize: Qt.size(width * 2, height * 2)
            smooth: true; mipmap: true
        }
        Text {
            anchors.centerIn: parent
            visible: glyph.status !== Image.Ready
            text: card.wx ? card.wx.icon : ""
            font.family: "Noto Color Emoji"; font.pixelSize: 46
        }
    }
    Rectangle { x: icon.x + icon.width + 18; width: 1; height: 64; anchors.verticalCenter: parent.verticalCenter; color: Theme.border }
    Column {
        x: icon.x + icon.width + 36; anchors.verticalCenter: parent.verticalCenter
        spacing: 2
        Text { text: card.wx ? card.wx.city : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14 }
        Text { text: card.wx ? card.wx.temp + "°" : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 36; font.weight: Font.Medium }
        Text {
            text: card.wx ? card.wx.text + (isFinite(card.wx.max) ? "  ·  " + card.wx.max + "° / " + card.wx.min + "°" : "") : ""
            color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
        }
    }
}
