import QtQuick
import "../shell"

// Ajustes → Bluetooth: on/off, the paired devices (connect, disconnect, forget) and a search for new ones (pair).
Item {
    id: page
    property var bt: null         // GET /devices → bluetooth
    property var found: []        // GET /devices/bluetooth (scan)
    property bool scanning: false
    property string busy: ""
    property string err: ""
    function load() { Session.request("GET", "/devices", null, function(s, j) { if (s === 200 && j) page.bt = j.bluetooth }) }
    function scan() {
        if (scanning) return
        scanning = true
        Session.request("GET", "/devices/bluetooth?seconds=6", null, function(s, j) { page.scanning = false; if (s === 200 && j) { page.found = j.devices || []; page.err = "" } else page.err = j && j.error ? j.error : "No se ha podido buscar." })
    }
    function post(p, b) { busy = b.mac || "x"; Session.request("POST", p, b, function(s, j) { page.busy = ""; page.err = s === 200 ? "" : (j && j.error ? j.error : "No se ha podido hacer el cambio."); page.load(); if (s === 200 && p.indexOf("pair") >= 0) page.scan() }) }
    readonly property var paired: bt && bt.devices ? bt.devices : []
    readonly property var fresh: found.filter(function(d) { return !d.paired })
    onVisibleChanged: if (visible) load()
    Component.onCompleted: load()
    Timer { interval: 15000; running: page.visible; repeat: true; onTriggered: page.load() }

    Flickable {
        anchors.fill: parent; contentWidth: width; contentHeight: col.height + 20; clip: true; boundsBehavior: Flickable.StopAtBounds
        Column {
            id: col
            width: parent.width - 14; spacing: 14
            Text { text: "Bluetooth"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.Bold }
            Text { visible: page.err !== ""; width: parent.width; wrapMode: Text.Wrap; text: page.err; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
            SettingsCard {
                Item {
                    width: parent.width; height: 44
                    Column {
                        anchors.verticalCenter: parent.verticalCenter
                        Text { text: "Bluetooth"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
                        Text { text: !page.bt ? "Comprobando…" : !page.bt.available ? "Este equipo no tiene Bluetooth" : page.bt.on ? "Encendido · visible para emparejar" : "Apagado"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                    }
                    NexusSwitch { anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; checked: !!(page.bt && page.bt.on); enabled: !!(page.bt && page.bt.available); onToggled: page.post("/devices/bluetooth", { on: checked }) }
                }
            }
            SettingsCard {
                visible: !!(page.bt && page.bt.on)
                title: "Mis dispositivos"
                note: page.paired.length === 0 ? "Todavía no hay ninguno emparejado." : ""
                Repeater {
                    model: page.paired
                    Item {
                        required property var modelData
                        width: parent.width; height: 44
                        LineIcon { anchors.verticalCenter: parent.verticalCenter; name: "bluetooth"; size: 18; color: modelData.connected ? Theme.accent : Theme.dim }
                        Column {
                            x: 30; anchors.verticalCenter: parent.verticalCenter
                            Text { text: modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                            Text { text: modelData.connected ? "Conectado" : "No conectado" + " · " + modelData.mac; color: Theme.dim; font.family: Theme.font; font.pixelSize: 11 }
                        }
                        Row {
                            anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; spacing: 6
                            SettingsButton { label: page.busy === modelData.mac ? "…" : modelData.connected ? "Desconectar" : "Conectar"; primary: !modelData.connected; onClicked: page.post("/devices/bluetooth/connect", { mac: modelData.mac, on: !modelData.connected }) }
                            SettingsButton { label: "Olvidar"; danger: true; onClicked: page.post("/devices/bluetooth/forget", { mac: modelData.mac }) }
                        }
                    }
                }
            }
            SettingsCard {
                visible: !!(page.bt && page.bt.on)
                title: page.scanning ? "Buscando dispositivos…" : "Otros dispositivos"
                note: "Pon el dispositivo en modo de emparejamiento y pulsa Buscar. Al emparejarlo se conecta y queda guardado."
                Repeater {
                    model: page.fresh
                    Item {
                        required property var modelData
                        width: parent.width; height: 40
                        LineIcon { anchors.verticalCenter: parent.verticalCenter; name: "bluetooth"; size: 18; color: Theme.dim }
                        Text { x: 30; anchors.verticalCenter: parent.verticalCenter; text: modelData.name + "  ·  " + modelData.mac; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                        SettingsButton { anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; label: page.busy === modelData.mac ? "Emparejando…" : "Emparejar"; primary: true; onClicked: page.post("/devices/bluetooth/pair", { mac: modelData.mac }) }
                    }
                }
                SettingsButton { label: page.scanning ? "Buscando…" : "Buscar"; enabled: !page.scanning; onClicked: page.scan() }
            }
        }
    }
}
