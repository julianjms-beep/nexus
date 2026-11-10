// nexus-lockbar: gtklock 4 module for the NEXUS lock screen (loaded by /usr/bin/nexus-lock with -m).
// SPDX-License-Identifier: GPL-3.0-or-later   (it is loaded into gtklock, which is GPL-3.0-or-later)
//
// What docs/concepto/3-bloqueo-concepto.png has and a gtklock layout file cannot do on its own:
//  - bottom right: network, battery (only when the computer has one) and a power button. The button opens
//    Suspender / Reiniciar / Apagar in place (a revealer, not a popup: popups do not work on a lock surface) and
//    runs `systemctl suspend|reboot|poweroff` like the desktop's power menu (logind allows it to the person at the
//    screen). Network and battery are read from /sys every 10 s.
//  - the date with a capital first letter ("Lunes, 9 de noviembre"), like the desktop; strftime gives "lunes".
// Icons are drawn with cairo (line style of shell/LineIcon.qml), so no icon theme is needed.
//
// Build (Debian trixie, gtklock 4.0.0): os/lock-module/build.sh

#include <gtk/gtk.h>
#include <stdlib.h>
#include <string.h>

#include "window.h"

struct GtkLock;

const gchar module_name[] = "nexus-lockbar";
const guint module_major_version = 4;
const guint module_minor_version = 0;

static int self_id = -1;

typedef struct {
	GtkWidget *net, *bat, *bat_label, *bat_sep, *menu, *power;
	gboolean online, wireless, has_battery, charging;
	int level;
	guint timer, hide;
} Bar;

#define WHITE(cr, a) cairo_set_source_rgba(cr, 1, 1, 1, a)

// --- state from /sys ---------------------------------------------------------------------------------------------
static gchar *read_line(const char *dir, const char *name) {
	gchar *path = g_build_filename(dir, name, NULL), *text = NULL;
	if(g_file_get_contents(path, &text, NULL, NULL)) g_strstrip(text);
	g_free(path);
	return text;
}

static void read_state(Bar *b) {
	b->online = b->wireless = FALSE;
	GDir *d = g_dir_open("/sys/class/net", 0, NULL);
	const char *n;
	while(d && (n = g_dir_read_name(d))) {
		if(strcmp(n, "lo") == 0) continue;
		gchar *dir = g_build_filename("/sys/class/net", n, NULL);
		gchar *oper = read_line(dir, "operstate");
		gchar *wl = g_build_filename(dir, "wireless", NULL);
		if(oper && strcmp(oper, "up") == 0) {
			b->online = TRUE;
			if(g_file_test(wl, G_FILE_TEST_IS_DIR)) b->wireless = TRUE;
		}
		g_free(oper); g_free(wl); g_free(dir);
	}
	if(d) g_dir_close(d);

	b->has_battery = b->charging = FALSE;
	b->level = 0;
	d = g_dir_open("/sys/class/power_supply", 0, NULL);
	while(d && (n = g_dir_read_name(d))) {
		gchar *dir = g_build_filename("/sys/class/power_supply", n, NULL);
		gchar *type = read_line(dir, "type"), *scope = read_line(dir, "scope");
		gchar *cap = read_line(dir, "capacity"), *status = read_line(dir, "status");
		// the computer's own battery (not a mouse or headphones: those report scope "Device")
		if(!b->has_battery && type && strcmp(type, "Battery") == 0 && cap && !(scope && strcmp(scope, "Device") == 0)) {
			b->has_battery = TRUE;
			b->level = CLAMP(atoi(cap), 0, 100);
			b->charging = status && (strcmp(status, "Charging") == 0 || strcmp(status, "Full") == 0);
		}
		g_free(type); g_free(scope); g_free(cap); g_free(status); g_free(dir);
	}
	if(d) g_dir_close(d);
}

// --- icons (24 x 24 points, 1.8 pt white lines) ------------------------------------------------------------------
static gboolean draw_net(GtkWidget *w, cairo_t *cr, Bar *b) {
	cairo_set_line_width(cr, 1.8);
	cairo_set_line_cap(cr, CAIRO_LINE_CAP_ROUND);
	double cx = 12, cy = 18.5;
	WHITE(cr, b->online ? 0.92 : 0.35);
	for(int i = 1; i <= 3; i++) {                      // three arcs above a dot, as in the desktop's WifiGlyph
		cairo_new_sub_path(cr);
		cairo_arc(cr, cx, cy, i * 4.6, G_PI * 1.25, G_PI * 1.75);
		cairo_stroke(cr);
	}
	cairo_arc(cr, cx, cy, 1.5, 0, 2 * G_PI);
	cairo_fill(cr);
	if(!b->online) {                                   // no network: struck through
		WHITE(cr, 0.92);
		cairo_move_to(cr, 4, 4); cairo_line_to(cr, 20, 20);
		cairo_stroke(cr);
	}
	return TRUE;
}

static void rounded(cairo_t *cr, double x, double y, double w, double h, double r) {
	cairo_new_sub_path(cr);
	cairo_arc(cr, x + w - r, y + r, r, -G_PI / 2, 0);
	cairo_arc(cr, x + w - r, y + h - r, r, 0, G_PI / 2);
	cairo_arc(cr, x + r, y + h - r, r, G_PI / 2, G_PI);
	cairo_arc(cr, x + r, y + r, r, G_PI, 1.5 * G_PI);
	cairo_close_path(cr);
}

static gboolean draw_bat(GtkWidget *w, cairo_t *cr, Bar *b) {
	cairo_set_line_width(cr, 1.6);
	WHITE(cr, 0.92);
	rounded(cr, 1.5, 6.5, 21, 11, 2.6);                // body
	cairo_stroke(cr);
	rounded(cr, 23.5, 9.5, 2, 5, 1);                   // terminal
	cairo_fill(cr);
	double fill = 17 * b->level / 100.0;               // charge, inside the body
	if(b->level <= 15 && !b->charging) cairo_set_source_rgba(cr, 1, 0.42, 0.42, 0.95);
	rounded(cr, 3.5, 8.5, MAX(fill, 2), 7, 1.4);
	cairo_fill(cr);
	if(b->charging) {                                  // small bolt over the body
		cairo_set_source_rgba(cr, 0.04, 0.05, 0.1, 0.9);
		cairo_move_to(cr, 13.2, 7.6); cairo_line_to(cr, 9.4, 12.6); cairo_line_to(cr, 12.2, 12.6);
		cairo_line_to(cr, 10.8, 16.4); cairo_line_to(cr, 14.6, 11.4); cairo_line_to(cr, 11.8, 11.4);
		cairo_close_path(cr);
		cairo_fill(cr);
	}
	return TRUE;
}

static gboolean draw_power(GtkWidget *w, cairo_t *cr, gpointer data) {
	cairo_set_line_width(cr, 1.9);
	cairo_set_line_cap(cr, CAIRO_LINE_CAP_ROUND);
	WHITE(cr, 0.92);
	cairo_arc(cr, 12, 13, 7.5, -G_PI / 2 + 0.75, 1.5 * G_PI - 0.75);
	cairo_stroke(cr);
	cairo_move_to(cr, 12, 3.8); cairo_line_to(cr, 12, 12);
	cairo_stroke(cr);
	return TRUE;
}

static GtkWidget *icon(GCallback draw, gpointer data, int width) {
	GtkWidget *a = gtk_drawing_area_new();
	gtk_widget_set_size_request(a, width, 24);
	gtk_widget_set_valign(a, GTK_ALIGN_CENTER);
	g_signal_connect(a, "draw", draw, data);
	return a;
}

static GtkWidget *separator(void) {
	GtkWidget *s = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
	gtk_style_context_add_class(gtk_widget_get_style_context(s), "nexus-sep");
	gtk_widget_set_valign(s, GTK_ALIGN_CENTER);
	return s;
}

// --- updates -----------------------------------------------------------------------------------------------------
static void refresh(Bar *b) {
	read_state(b);
	gtk_widget_set_tooltip_text(b->net, b->online ? (b->wireless ? "Conectado a la red Wi-Fi" : "Conectado a la red")
	                                              : "Sin red");
	gtk_widget_set_visible(b->bat, b->has_battery);
	gtk_widget_set_visible(b->bat_label, b->has_battery);
	gtk_widget_set_visible(b->bat_sep, b->has_battery);
	if(b->has_battery) {
		gchar *t = g_strdup_printf("%d%%", b->level);
		gtk_label_set_text(GTK_LABEL(b->bat_label), t);
		g_free(t);
	}
	gtk_widget_queue_draw(b->net);
	gtk_widget_queue_draw(b->bat);
}

static gboolean tick(gpointer data) {
	refresh(data);
	return G_SOURCE_CONTINUE;
}

static gboolean auto_hide(gpointer data) {
	Bar *b = data;
	b->hide = 0;
	gtk_revealer_set_reveal_child(GTK_REVEALER(b->menu), FALSE);
	return G_SOURCE_REMOVE;
}

static void toggle_menu(GtkButton *button, Bar *b) {
	gboolean open = !gtk_revealer_get_reveal_child(GTK_REVEALER(b->menu));
	gtk_revealer_set_reveal_child(GTK_REVEALER(b->menu), open);
	if(b->hide) g_source_remove(b->hide);
	b->hide = open ? g_timeout_add_seconds(8, auto_hide, b) : 0;
}

static void run_power(GtkButton *button, gpointer verb) {
	gchar *argv[] = { "systemctl", verb, NULL };
	GError *err = NULL;
	if(!g_spawn_async(NULL, argv, NULL, G_SPAWN_SEARCH_PATH | G_SPAWN_STDOUT_TO_DEV_NULL | G_SPAWN_STDERR_TO_DEV_NULL,
	                  NULL, NULL, NULL, &err)) {
		g_warning("nexus-lockbar: systemctl %s: %s", (char *)verb, err->message);
		g_error_free(err);
	}
}

static GtkWidget *menu_item(const char *label, const char *verb) {
	GtkWidget *i = gtk_button_new_with_label(label);
	gtk_style_context_add_class(gtk_widget_get_style_context(i), "nexus-power-item");
	gtk_widget_set_can_focus(i, FALSE);              // the password field keeps the keyboard
	g_signal_connect(i, "clicked", G_CALLBACK(run_power), (gpointer)verb);
	return i;
}

// "lunes, 9 de noviembre" -> "Lunes, 9 de noviembre"; gtklock sets the text again at midnight, so this follows it
static void capitalise(GtkLabel *label) {
	const char *t = gtk_label_get_text(label);
	if(!t || !*t) return;
	gunichar c = g_utf8_get_char(t);
	if(!g_unichar_islower(c)) return;
	char first[8] = { 0 };
	g_unichar_to_utf8(g_unichar_totitle(c), first);
	gchar *s = g_strconcat(first, g_utf8_next_char(t), NULL);
	gtk_label_set_text(label, s);
	g_free(s);
}

static void on_date(GObject *label, GParamSpec *spec, gpointer data) {
	capitalise(GTK_LABEL(label));
}

// --- gtklock hooks -----------------------------------------------------------------------------------------------
void on_activation(struct GtkLock *gtklock, int id) {
	self_id = id;
}

void on_window_create(struct GtkLock *gtklock, struct Window *win) {
	if(self_id < 0) return;
	Bar *b = g_new0(Bar, 1);
	win->module_data[self_id] = b;

	if(win->date_label) {
		g_signal_connect(win->date_label, "notify::label", G_CALLBACK(on_date), NULL);
		capitalise(GTK_LABEL(win->date_label));
	}

	GtkWidget *bar = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
	gtk_widget_set_name(bar, "nexus-status");
	gtk_widget_set_halign(bar, GTK_ALIGN_END);
	gtk_widget_set_valign(bar, GTK_ALIGN_END);

	b->menu = gtk_revealer_new();
	gtk_revealer_set_transition_type(GTK_REVEALER(b->menu), GTK_REVEALER_TRANSITION_TYPE_SLIDE_LEFT);
	gtk_revealer_set_transition_duration(GTK_REVEALER(b->menu), 220);
	GtkWidget *items = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
	gtk_widget_set_name(items, "nexus-power-menu");
	gtk_container_add(GTK_CONTAINER(items), menu_item("Suspender", "suspend"));
	gtk_container_add(GTK_CONTAINER(items), menu_item("Reiniciar", "reboot"));
	gtk_container_add(GTK_CONTAINER(items), menu_item("Apagar", "poweroff"));
	gtk_container_add(GTK_CONTAINER(b->menu), items);
	gtk_container_add(GTK_CONTAINER(bar), b->menu);

	b->net = icon(G_CALLBACK(draw_net), b, 24);
	gtk_container_add(GTK_CONTAINER(bar), b->net);
	b->bat_sep = separator();
	gtk_container_add(GTK_CONTAINER(bar), b->bat_sep);
	b->bat = icon(G_CALLBACK(draw_bat), b, 27);
	gtk_container_add(GTK_CONTAINER(bar), b->bat);
	b->bat_label = gtk_label_new("");
	gtk_widget_set_name(b->bat_label, "nexus-battery");
	gtk_container_add(GTK_CONTAINER(bar), b->bat_label);
	gtk_container_add(GTK_CONTAINER(bar), separator());

	b->power = gtk_button_new();
	gtk_widget_set_name(b->power, "nexus-power-button");
	gtk_widget_set_tooltip_text(b->power, "Apagar o reiniciar");
	gtk_widget_set_can_focus(b->power, FALSE);
	gtk_container_add(GTK_CONTAINER(b->power), icon(G_CALLBACK(draw_power), NULL, 24));
	g_signal_connect(b->power, "clicked", G_CALLBACK(toggle_menu), b);
	gtk_container_add(GTK_CONTAINER(bar), b->power);

	// gtklock shows the whole window (show_all) after this hook: the battery parts keep their own visibility
	gtk_widget_set_no_show_all(b->bat, TRUE);
	gtk_widget_set_no_show_all(b->bat_label, TRUE);
	gtk_widget_set_no_show_all(b->bat_sep, TRUE);
	gtk_overlay_add_overlay(GTK_OVERLAY(win->overlay), bar);
	gtk_widget_show_all(bar);
	refresh(b);                                        // shows the battery parts only when there is a battery
	b->timer = g_timeout_add_seconds(10, tick, b);
}

void on_window_destroy(struct GtkLock *gtklock, struct Window *win) {
	if(self_id < 0) return;
	Bar *b = win->module_data[self_id];
	if(!b) return;
	if(b->timer) g_source_remove(b->timer);
	if(b->hide) g_source_remove(b->hide);
	g_free(b);
	win->module_data[self_id] = NULL;
}
