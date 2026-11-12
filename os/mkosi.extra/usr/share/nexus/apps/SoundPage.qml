import QtQuick
import "../shell"

// Ajustes → Sonido: the volume, silence, which output plays (speakers, headphones, HDMI), what is playing.
Item {
    id: page
    property var st: null
    property var outs: null
    property string err: ""
    function load() {
        Session.request("GET", "/devices", null, function(s, j) { if (s === 200 && j) page.st = j })
        Session.request("GET", "/devices/sound", null, function(s, j) { if (s === 200 && j) page.outs = j })
    }
    function post(p, b) { Session.request("POST", p, b, function(s, j) { page.err = s === 200 ? "" : (j && j.error ? j.error : "No se ha podido hacer el cambio."); page.load() }) }
    readonly property var snd: st ? st.sound : null
    readonly property var media: st ? st.media : null
    onVisibleChanged: if (visible) load()
    Component.onCompleted: load()
    Timer { interval: 8000; running: page.visible; repeat: true; onTriggered: page.load() }

    Flickable {
        anchors.fill: parent; contentWidth: width; contentHeight: col.height + 20; clip: true; boundsBehavior: Flickable.StopAtBounds
        Column {
            id: col
            width: parent.width - 14; spacing: 14
            Text { text: "Sonido"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.Bold }
            Text { visible: page.err !== ""; width: parent.width; wrapMode: Text.Wrap; text: page.err; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
            SettingsCard {
                title: "Volumen"
                note: page.snd && !page.snd.available ? "No hay sistema de sonido en marcha (PipeWire)." : ""
                SettingsSlider { icon: page.snd && page.snd.muted ? "speaker-off" : "speaker"; label: "Volumen"; enabled: !!(page.snd && page.snd.available); value: page.snd ? page.snd.volume : 0; onMoved: (v) => page.post("/devices/sound", { volume: v }) }
                Item {
                    width: parent.width; height: 36
                    Text { anchors.verticalCenter: parent.verticalCenter; text: "Silencio"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                    NexusSwitch { anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; checked: !!(page.snd && page.snd.muted); enabled: !!(page.snd && page.snd.available); onToggled: page.post("/devices/sound", { muted: checked }) }
                }
            }
            SettingsCard {
                title: "Salida"
                note: !page.outs || !page.outs.available || page.outs.outputs.length === 0 ? "No se ha encontrado ninguna salida de sonido." : "Por dónde suena: elige una."
                Repeater {
                    model: page.outs && page.outs.outputs ? page.outs.outputs : []
                    Item {
                        required property var modelData
                        width: parent.width; height: 40
                        Rectangle { anchors.fill: parent; radius: 10; color: oma.containsMouse ? Theme.hover : "transparent" }
                        Rectangle { x: 8; anchors.verticalCenter: parent.verticalCenter; width: 10; height: 10; radius: 5; color: modelData.isDefault ? Theme.accent : "transparent"; border.color: modelData.isDefault ? Theme.accent : Theme.dim }
                        Text { x: 30; anchors.verticalCenter: parent.verticalCenter; text: modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: modelData.isDefault ? Font.DemiBold : Font.Normal }
                        MouseArea { id: oma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: page.post("/devices/sound/output", { id: modelData.id }) }
                    }
                }
            }
            SettingsCard {
                visible: !!page.media
                title: "Sonando ahora"
                Item {
                    width: parent.width; height: 44
                    LineIcon { anchors.verticalCenter: parent.verticalCenter; name: "music"; size: 20; color: Theme.accent }
                    Column {
                        x: 32; anchors.verticalCenter: parent.verticalCenter
                        Text { text: page.media ? page.media.title : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                        Text { text: page.media ? (page.media.artist ? page.media.artist + " · " : "") + page.media.player : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                    }
                    SettingsButton { anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; label: page.media && page.media.status === "Playing" ? "Pausa" : "Reproducir"; onClicked: page.post("/devices/media", { action: "play-pause" }) }
                }
            }
        }
    }
}
