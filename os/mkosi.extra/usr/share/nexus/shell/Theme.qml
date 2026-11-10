pragma Singleton
import QtQuick

// NEXUS design tokens. `dark` and `accent` follow the user's preferences (Session applies them).
QtObject {
    id: theme
    property bool dark: true
    property color accent: "#7c6cff"
    // Motion: false when the person turned Animaciones off (Ajustes). Durations go through ms() so they become instant.
    property bool motion: true
    function ms(d) { return motion ? d : 0 }
    // Apps get the person's theme on the command line (nexus-app), so their first frame is already right;
    // Session re-applies the same values once it has talked to nexus-sessiond.
    Component.onCompleted: {
        var a = Qt.application.arguments
        for (var i = 0; i < a.length; i++) {
            var v = String(a[i])
            if (v === "--nexus-theme=light") theme.dark = false
            else if (v === "--nexus-theme=dark") theme.dark = true
            else if (/^--nexus-accent=#[0-9a-fA-F]{6}$/.test(v)) theme.accent = v.slice(15)
            else if (v === "--nexus-motion=off") theme.motion = false
        }
    }
    property color accent2: "#38d9ff"
    readonly property color bg: dark ? "#0b0e17" : "#eef1f8"
    readonly property color panel: dark ? Qt.rgba(0.055, 0.067, 0.11, 0.80) : Qt.rgba(1, 1, 1, 0.80)
    // the desktop widgets' glass. Over a light wallpaper (a bright picture or colour: Session sets wallLight) the dark
    // glass would turn muddy brown-grey, so it gets more opaque there.
    property bool wallLight: false
    readonly property color glass: dark ? Qt.rgba(0.07, 0.08, 0.15, wallLight ? 0.86 : 0.56) : alpha(card, 0.80)
    readonly property color card: dark ? "#131726" : "#ffffff"
    readonly property color card2: dark ? "#1b2033" : "#f1f3f9"
    readonly property color hover: dark ? Qt.rgba(1, 1, 1, 0.07) : Qt.rgba(0, 0, 0, 0.05)
    readonly property color border: dark ? Qt.rgba(1, 1, 1, 0.09) : Qt.rgba(0, 0, 0, 0.09)
    readonly property color text: dark ? "#e8ebff" : "#151a2b"
    readonly property color dim: dark ? "#98a0c3" : "#5b6382"
    readonly property color faint: dark ? "#5d6488" : "#9aa1bb"
    readonly property color danger: "#ff5c7a"
    readonly property color good: "#3ddc97"
    readonly property color warn: "#ffb84d"
    readonly property string font: "Inter"
    readonly property string mono: "JetBrains Mono"
    function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }
}
