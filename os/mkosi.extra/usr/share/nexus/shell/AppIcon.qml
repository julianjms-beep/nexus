import QtQuick

Image {
    property string app: ""
    source: app ? Qt.resolvedUrl("../icons/app-" + app + ".svg") : ""
    sourceSize: Qt.size(Math.max(32, width * 2), Math.max(32, height * 2))
    smooth: true
    mipmap: true
}
