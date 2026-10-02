/**
 * Panel vocabulary.
 *
 * The panel spoke English at every user regardless of what Home Assistant was
 * set to, including the four languages this integration already ships for its
 * config flow. This module is the one place that is fixed.
 *
 * One table, whose entries come in two shapes.
 *
 * 1. An entry with an **`ha`** key names a string the frontend already has,
 *    and that one wins. A word Home Assistant owns is worth more than a word
 *    we translate ourselves: it is reviewed, it is complete in every language
 *    HA supports rather than the five we can write, and it makes our menus
 *    read like the rest of the interface instead of like a plugin. Only keys
 *    reachable from inside this panel may be named — the core bundle plus the
 *    `config` fragment, which `_loadHaTranslations()` pulls in on entry.
 *    `localize` answers "" for a fragment that is not loaded, so these entries
 *    also carry English, and only English: a second German for "Delete" would
 *    be read only when HA's is missing, and would rot unnoticed until then.
 *
 * 2. Every other entry is ours, for the phrases that are about this panel and
 *    have no counterpart anywhere in the frontend ("Page default", "Pinned in
 *    YAML"). These carry all five languages. English is the fallback for every
 *    language we do not write, so a gap degrades to the behaviour the panel
 *    had before rather than to a blank label.
 *
 * Phrases spelled identically in all five — "URL", "Min", "Max" — are not here
 * at all; they stay plain literals at their call sites.
 *
 * `{name}`-style placeholders are substituted by `_t`. They exist so a
 * sentence stays one translatable unit: German and French put the verb
 * somewhere English does not, and a sentence assembled from three concatenated
 * fragments cannot be reordered by a translator.
 */

/** id → { en, de, fr, it, es }. English doubles as the fallback. */
export const STRINGS = {
  // ── what Home Assistant already says ───────────────────────────────
  //
  // `ha` names the frontend's own string, which wins whenever `localize`
  // answers. The English beside it is what remains when it does not: an
  // unloaded fragment, or a key a future frontend renames. Deliberately not
  // borrowed: "Label", which in HA is the tagging feature and here is a
  // button's caption, and "Control", which for us names the quantity a slider
  // writes rather than the widget HA means by it.
  cancel: { ha: "ui.common.cancel", en: "Cancel" },
  delete: { ha: "ui.common.delete", en: "Delete" },
  name: { ha: "ui.common.name", en: "Name" },
  icon: { ha: "ui.dialogs.label-detail.icon", en: "Icon" },
  image: { ha: "ui.components.selectors.image.image", en: "Image" },
  custom: { ha: "ui.panel.config.backup.data.apps_custom", en: "Custom" },
  filter: { ha: "ui.components.related-filter-menu.filter", en: "Filter…" },
  move: { ha: "ui.common.move", en: "Move" },
  clear: { ha: "ui.common.clear", en: "Clear" },
  select_device: { ha: "ui.components.device-picker.placeholder", en: "Select a device" },
  actions: { ha: "ui.panel.config.generic.headers.actions", en: "Actions" },
  delete_failed: { ha: "ui.common.deleting_failed", en: "Deleting failed" },
  attribute: { ha: "ui.components.selectors.selector.types.attribute", en: "Attribute" },
  entity: { ha: "ui.components.selectors.selector.types.entity", en: "Entity" },
  service: { ha: "ui.dialogs.more_info_control.device_type.service", en: "Service" },

  // Not here on purpose: "URL", "Min", "Max" and the debug tab's "Ping". They
  // are spelled the same in all five languages, so they stay plain literals at
  // their call sites — routing them through `_t` would only add a lookup that
  // can never differ.

  // ── tabs and section headings ──────────────────────────────────────
  tab_buttons: {
    en: "Buttons", de: "Tasten", fr: "Touches", it: "Tasti", es: "Botones",
  },

  // ── settings tab ───────────────────────────────────────────────────
  tab_settings: {
    en: "Settings", de: "Einstellungen", fr: "Paramètres", it: "Impostazioni", es: "Ajustes",
  },
  settings_title: {
    en: "Page title", de: "Seitentitel", fr: "Titre de page", it: "Titolo pagina", es: "Título de página",
  },
  settings_tooltip: {
    en: "Tooltip", de: "Tooltip", fr: "Info-bulle", it: "Descrizione comando", es: "Información sobre herramientas",
  },
  settings_font: {
    en: "Font", de: "Schriftart", fr: "Police", it: "Carattere", es: "Fuente",
  },
  settings_font_size: {
    en: "Font size", de: "Schriftgröße", fr: "Taille de police", it: "Dimensione carattere", es: "Tamaño de fuente",
  },
  settings_font_size_hint: {
    en: "In pixels, from {min} to {max}.",
    de: "In Pixeln, von {min} bis {max}.",
    fr: "En pixels, de {min} à {max}.",
    it: "In pixel, da {min} a {max}.",
    es: "En píxeles, de {min} a {max}.",
  },
  settings_font_user: {
    en: "{name} (your font)", de: "{name} (eigene Schrift)", fr: "{name} (votre police)",
    it: "{name} (tuo carattere)", es: "{name} (tu fuente)",
  },
  settings_font_missing: {
    en: "{name} (not installed)", de: "{name} (nicht installiert)", fr: "{name} (non installée)",
    it: "{name} (non installato)", es: "{name} (no instalada)",
  },
  settings_preview: {
    en: "Preview", de: "Vorschau", fr: "Aperçu", it: "Anteprima", es: "Vista previa",
  },
  settings_sample_title: {
    en: "Living room", de: "Wohnzimmer", fr: "Salon", it: "Soggiorno", es: "Salón",
  },
  settings_sample_tooltip: {
    en: "Lights on", de: "Licht an", fr: "Lumière allumée", it: "Luce accesa", es: "Luz encendida",
  },
  settings_loading: {
    en: "Loading settings…", de: "Einstellungen werden geladen…", fr: "Chargement des paramètres…",
    it: "Caricamento impostazioni…", es: "Cargando ajustes…",
  },
  settings_fonts_hint: {
    en: "To use a font of your own, put its .ttf or .otf file in {path} and reopen this tab.",
    de: "Für eine eigene Schrift legen Sie die .ttf- oder .otf-Datei in {path} ab und öffnen diesen Tab erneut.",
    fr: "Pour utiliser votre propre police, placez son fichier .ttf ou .otf dans {path} et rouvrez cet onglet.",
    it: "Per usare un carattere tuo, metti il file .ttf o .otf in {path} e riapri questa scheda.",
    es: "Para usar una fuente propia, coloca su archivo .ttf u .otf en {path} y vuelve a abrir esta pestaña.",
  },
  // NotoColorEmoji.ttf is too large to ship, so colour emoji are opt-in.
  settings_emoji_hint: {
    en: "For colour emoji in titles and labels, also put NotoColorEmoji.ttf in {path}.",
    de: "Für farbige Emojis in Titeln und Beschriftungen legen Sie zusätzlich NotoColorEmoji.ttf in {path} ab.",
    fr: "Pour des emoji en couleur dans les titres et libellés, placez aussi NotoColorEmoji.ttf dans {path}.",
    it: "Per emoji a colori in titoli ed etichette, metti anche NotoColorEmoji.ttf in {path}.",
    es: "Para emojis en color en títulos y etiquetas, coloca también NotoColorEmoji.ttf en {path}.",
  },
  settings_reset: {
    en: "Restore defaults", de: "Standard wiederherstellen", fr: "Rétablir les valeurs par défaut",
    it: "Ripristina predefiniti", es: "Restablecer valores predeterminados",
  },
  settings_saved: {
    en: "Settings saved. The remote redraws its pages.",
    de: "Einstellungen gespeichert. Die Fernbedienung zeichnet ihre Seiten neu.",
    fr: "Paramètres enregistrés. La télécommande redessine ses pages.",
    it: "Impostazioni salvate. Il telecomando ridisegna le sue pagine.",
    es: "Ajustes guardados. El mando vuelve a dibujar sus páginas.",
  },
  settings_save_failed: {
    en: "Saving failed: {error}", de: "Speichern fehlgeschlagen: {error}", fr: "Échec de l'enregistrement : {error}",
    it: "Salvataggio non riuscito: {error}", es: "Error al guardar: {error}",
  },

  // ── debug tab ──────────────────────────────────────────────────────
  // Only reachable on a build that carries the debug tooling; the strings
  // stay here regardless, because the i18n table is shipped whole and one
  // missing key would render as its own name.
  tab_debug: {
    en: "Debug", de: "Diagnose", fr: "Diagnostic", it: "Diagnostica", es: "Diagnóstico",
  },
  debug_reachability: {
    en: "Reachability", de: "Erreichbarkeit", fr: "Accessibilité",
    it: "Raggiungibilità", es: "Accesibilidad",
  },
  debug_not_tested: {
    en: "Not tested yet.", de: "Noch nicht getestet.", fr: "Pas encore testé.",
    it: "Non ancora testato.", es: "Aún sin probar.",
  },
  debug_never_connected: {
    en: "The remote has never connected, so there is no address to test.",
    de: "Die Fernbedienung hat sich noch nie verbunden, daher gibt es keine Adresse zum Testen.",
    fr: "La télécommande ne s'est jamais connectée, il n'y a donc aucune adresse à tester.",
    it: "Il telecomando non si è mai connesso, quindi non c'è alcun indirizzo da testare.",
    es: "El mando nunca se ha conectado, por lo que no hay dirección que probar.",
  },
  debug_reachable: {
    en: "Reachable", de: "Erreichbar", fr: "Accessible",
    it: "Raggiungibile", es: "Accesible",
  },
  debug_unreachable: {
    en: "Not reachable", de: "Nicht erreichbar", fr: "Inaccessible",
    it: "Non raggiungibile", es: "No accesible",
  },
  debug_address: {
    en: "Address", de: "Adresse", fr: "Adresse", it: "Indirizzo", es: "Dirección",
  },
  debug_latency: {
    en: "Response time", de: "Antwortzeit", fr: "Temps de réponse",
    it: "Tempo di risposta", es: "Tiempo de respuesta",
  },
  debug_error: {
    en: "Error", de: "Fehler", fr: "Erreur", it: "Errore", es: "Error",
  },
  debug_websocket: {
    en: "WebSocket", de: "WebSocket", fr: "WebSocket", it: "WebSocket", es: "WebSocket",
  },
  debug_connected: {
    en: "Connected", de: "Verbunden", fr: "Connecté", it: "Connesso", es: "Conectado",
  },
  debug_disconnected: {
    en: "Disconnected", de: "Getrennt", fr: "Déconnecté",
    it: "Disconnesso", es: "Desconectado",
  },
  debug_log_port: {
    en: "Device log stream", de: "Geräteprotokoll-Stream", fr: "Flux de journal de l'appareil",
    it: "Flusso di log del dispositivo", es: "Flujo de registro del dispositivo",
  },
  debug_log_port_hint: {
    en: "Opens the remote's debug port and writes its output to the Home Assistant log at debug level. Turn it off again when you are done — it is not kept across restarts.",
    de: "Öffnet den Debug-Port der Fernbedienung und schreibt deren Ausgabe auf Debug-Ebene ins Home-Assistant-Protokoll. Danach wieder ausschalten — die Einstellung übersteht keinen Neustart.",
    fr: "Ouvre le port de débogage de la télécommande et écrit sa sortie dans le journal Home Assistant au niveau debug. Désactivez-le ensuite : il n'est pas conservé après un redémarrage.",
    it: "Apre la porta di debug del telecomando e scrive il suo output nel log di Home Assistant a livello debug. Disattivalo quando hai finito: non viene mantenuto dopo un riavvio.",
    es: "Abre el puerto de depuración del mando y escribe su salida en el registro de Home Assistant en nivel debug. Desactívalo al terminar: no se conserva tras un reinicio.",
  },
  // A switch reports a state, where a button named an action. "Disable" on a
  // control that is already off read as the thing it would do, which is the
  // opposite of what a switch means.
  debug_stream_on: {
    en: "On", de: "Ein", fr: "Activé", it: "Attivo", es: "Activado",
  },
  debug_stream_off: {
    en: "Off", de: "Aus", fr: "Désactivé", it: "Disattivo", es: "Desactivado",
  },
  // Shown only while the stream is running. The lines do not appear in the
  // panel -- they go into Home Assistant's own log -- so without this the
  // switch would look like it had done nothing.
  //
  // The second sentence is not padding. That page opens on the grouped list fed
  // by the system_log integration, whose handler sits at WARNING, so these
  // DEBUG lines can never appear there. Only the raw view renders them, and it
  // is reached by a button: ha-config-logs keeps that choice in internal state,
  // never in the URL, so the link cannot land on it and the reader has to be
  // told. The button is named through Home Assistant's own string, so it reads
  // exactly as this instance labels it rather than as a guess of ours.
  debug_stream_live: {
    en: "The device's lines are being written to {link}. That page opens on the "
      + "grouped warnings and errors, where these lines never appear — use "
      + "\u201c{button}\u201d to see them.",
    de: "Die Zeilen des Geräts werden nach {link} geschrieben. Diese Seite "
      + "öffnet zuerst die gruppierten Warnungen und Fehler, in denen diese "
      + "Zeilen nie auftauchen — mit \u201e{button}\u201c werden sie sichtbar.",
    fr: "Les lignes de l'appareil sont écrites dans {link}. Cette page s'ouvre "
      + "sur les avertissements et erreurs groupés, où ces lignes n'apparaissent "
      + "jamais — utilisez «\u202f{button}\u202f» pour les voir.",
    it: "Le righe del dispositivo vengono scritte in {link}. Quella pagina si "
      + "apre sugli avvisi e sugli errori raggruppati, dove queste righe non "
      + "compaiono mai: usa \u201c{button}\u201d per vederle.",
    es: "Las líneas del dispositivo se escriben en {link}. Esa página se abre "
      + "en las advertencias y los errores agrupados, donde estas líneas nunca "
      + "aparecen: usa \u201c{button}\u201d para verlas.",
  },
  // Home Assistant's own label for the button that switches the log page to the
  // raw view. Taking it from its string means the hint names what the reader
  // actually sees, in whatever language the instance runs -- which is also why
  // only English is carried here: the instance supplies the rest, and a second
  // set of our own could only contradict it.
  debug_stream_raw_button: {
    ha: "ui.panel.config.logs.show_full_logs", en: "Show raw logs",
  },
  // Shown when the device's port is open but nothing is reading it -- the
  // state a restart of Home Assistant leaves behind, since the port survives
  // it and the task reading the port does not.
  debug_stream_detached: {
    en: "The port is open on the device, but these lines are not being "
      + "collected. Switch it off and on again to start reading it.",
    de: "Der Port am Gerät ist offen, aber die Zeilen werden nicht "
      + "eingesammelt. Zum Mitlesen den Schalter aus- und wieder einschalten.",
    fr: "Le port est ouvert sur l'appareil, mais ces lignes ne sont pas "
      + "collectées. Éteignez puis rallumez l'interrupteur pour les lire.",
    it: "La porta è aperta sul dispositivo, ma queste righe non vengono "
      + "raccolte. Spegni e riaccendi l'interruttore per leggerle.",
    es: "El puerto está abierto en el dispositivo, pero estas líneas no se "
      + "recogen. Apaga y vuelve a encender el interruptor para leerlas.",
  },
  // The read failed without saying why. The switch keeps showing what it last
  // knew rather than claiming the port is closed.
  debug_port_unknown: {
    en: "Could not read the port's state from the device.",
    de: "Der Zustand des Ports konnte nicht vom Gerät gelesen werden.",
    fr: "Impossible de lire l'état du port depuis l'appareil.",
    it: "Impossibile leggere lo stato della porta dal dispositivo.",
    es: "No se pudo leer el estado del puerto desde el dispositivo.",
  },
  debug_stream_live_link: {
    en: "the Home Assistant log", de: "das Home-Assistant-Protokoll",
    fr: "le journal Home Assistant", it: "il registro di Home Assistant",
    es: "el registro de Home Assistant",
  },
  // The per-module log levels. The level names themselves are not translated:
  // they are the values the device takes, and a translated "off" sent back
  // would be refused. They are shown as the device spells them.
  debug_logging: {
    en: "Log levels", de: "Protokollstufen", fr: "Niveaux de journalisation",
    it: "Livelli di log", es: "Niveles de registro",
  },
  debug_logging_hint: {
    en: "Which parts of the remote's firmware write to its log, and how much.",
    de: "Welche Teile der Firmware der Fernbedienung protokollieren und wie ausführlich.",
    fr: "Quelles parties du micrologiciel de la télécommande écrivent dans son journal, et à quel point.",
    it: "Quali parti del firmware del telecomando scrivono nel suo log e con quanto dettaglio.",
    es: "Qué partes del firmware del mando escriben en su registro y con cuánto detalle.",
  },
  debug_logging_loading: {
    en: "Reading…", de: "Wird gelesen…", fr: "Lecture…",
    it: "Lettura…", es: "Leyendo…",
  },
  // The two states of the per-section button: the label says what a click
  // will do, not what is currently shown.
  debug_pretty: {
    en: "Pretty", de: "Formatiert", fr: "Format\u00e9", it: "Formattato",
    es: "Formateado",
  },
  debug_raw: {
    en: "Raw", de: "Roh", fr: "Brut", it: "Grezzo", es: "Sin formato",
  },
  debug_logging_reset: {
    en: "Reset all to important", de: "Alle auf \u201eimportant\u201c zur\u00fccksetzen",
    fr: "Tout remettre sur \u00ab\u202fimportant\u202f\u00bb",
    it: "Reimposta tutto su \u201cimportant\u201d",
    es: "Restablecer todo a \u201cimportant\u201d",
  },
  debug_logging_empty: {
    en: "The remote did not report any log modules.",
    de: "Die Fernbedienung hat keine Protokollmodule gemeldet.",
    fr: "La télécommande n'a signalé aucun module de journalisation.",
    it: "Il telecomando non ha segnalato alcun modulo di log.",
    es: "El mando no ha informado de ningún módulo de registro.",
  },
  debug_logging_version: {
    en: "Schema version {version}", de: "Schemaversion {version}",
    fr: "Version du schéma {version}", it: "Versione dello schema {version}",
    es: "Versión del esquema {version}",
  },

  debug_report: {
    en: "Device report", de: "Gerätebericht", fr: "Rapport de l'appareil",
    it: "Rapporto del dispositivo", es: "Informe del dispositivo",
  },
  debug_report_hint: {
    en: "Reads the remote's status, metrics and stored logs. Each section is read from the remote when you expand it. Useful to attach to a bug report.",
    de: "Liest Status, Messwerte und gespeicherte Protokolle der Fernbedienung. Jeder Abschnitt wird beim Aufklappen von der Fernbedienung gelesen. Nützlich als Anhang zu einer Fehlermeldung.",
    fr: "Lit l'état, les mesures et les journaux enregistrés de la télécommande. Chaque section est lue sur la télécommande au moment où vous la dépliez. Utile à joindre à un rapport de bogue.",
    it: "Legge stato, metriche e log memorizzati del telecomando. Ogni sezione viene letta dal telecomando quando la espandi. Utile da allegare a una segnalazione di bug.",
    es: "Lee el estado, las métricas y los registros almacenados del mando. Cada sección se lee del mando al desplegarla. Útil para adjuntar a un informe de error.",
  },
  // Shown while the list of readable endpoints is being fetched. The card is
  // empty until it arrives, and an empty card says nothing about whether
  // anything is happening. ("Ping" stays hard-coded in the view: the word is
  // identical in all five languages.)
  debug_report_fetching: {
    en: "Collecting report…", de: "Bericht wird abgerufen…",
    fr: "Collecte du rapport…", it: "Raccolta del rapporto…",
    es: "Recopilando informe…",
  },
  // Shown on a row that is on the list but has not been fetched yet. The rows
  // appear before any of them is collected, so each needs to say which it is.
  debug_section_pending: {
    en: "collecting…", de: "wird abgerufen…", fr: "collecte…",
    it: "raccolta…", es: "recopilando…",
  },
  debug_section_truncated: {
    en: "Cut off — the device sent {length} characters.",
    de: "Abgeschnitten — das Gerät sendete {length} Zeichen.",
    fr: "Tronqué — l'appareil a envoyé {length} caractères.",
    it: "Troncato — il dispositivo ha inviato {length} caratteri.",
    es: "Truncado — el dispositivo envió {length} caracteres.",
  },
  debug_report_copy: {
    en: "Copy", de: "Kopieren", fr: "Copier", it: "Copia", es: "Copiar",
  },
  debug_report_copied: {
    en: "Report copied to the clipboard ✓",
    de: "Bericht in die Zwischenablage kopiert ✓",
    fr: "Rapport copié dans le presse-papiers ✓",
    it: "Rapporto copiato negli appunti ✓",
    es: "Informe copiado al portapapeles ✓",
  },
  debug_report_copy_failed: {
    en: "Could not copy: {error}",
    de: "Kopieren fehlgeschlagen: {error}",
    fr: "Copie impossible : {error}",
    it: "Copia non riuscita: {error}",
    es: "No se pudo copiar: {error}",
  },
  action_library: {
    en: "Action Library", de: "Aktionsbibliothek", fr: "Bibliothèque d'actions",
    it: "Libreria azioni", es: "Biblioteca de acciones",
  },
  appearance: {
    en: "Appearance", de: "Darstellung", fr: "Apparence",
    it: "Aspetto", es: "Apariencia",
  },
  button_icons: {
    en: "Button icons", de: "Tastensymbole", fr: "Icônes des touches",
    it: "Icone dei tasti", es: "Iconos de los botones",
  },
  icon_color: {
    en: "Icon color", de: "Symbolfarbe", fr: "Couleur des icônes",
    it: "Colore delle icone", es: "Color de los iconos",
  },
  layout: {
    en: "Layout", de: "Layout", fr: "Disposition",
    it: "Layout", es: "Diseño",
  },

  // ── pages ──────────────────────────────────────────────────────────
  add_page: {
    en: "Add page", de: "Seite hinzufügen", fr: "Ajouter une page",
    it: "Aggiungi pagina", es: "Añadir página",
  },
  add_new_page: {
    en: "Add new page", de: "Neue Seite hinzufügen", fr: "Ajouter une nouvelle page",
    it: "Aggiungi nuova pagina", es: "Añadir nueva página",
  },
  add_layout_page: {
    en: "Add layout page", de: "Layout-Seite hinzufügen",
    fr: "Ajouter une page de disposition", it: "Aggiungi pagina layout",
    es: "Añadir página de diseño",
  },
  adding: {
    en: "Adding…", de: "Wird hinzugefügt…", fr: "Ajout en cours…",
    it: "Aggiunta in corso…", es: "Añadiendo…",
  },
  blank_page: {
    en: "Blank page", de: "Leere Seite", fr: "Page vierge",
    it: "Pagina vuota", es: "Página en blanco",
  },
  delete_page: {
    en: "Delete page", de: "Seite löschen", fr: "Supprimer la page",
    it: "Elimina pagina", es: "Eliminar página",
  },
  // A subpage keeps everything a page has; it is only taken out of the list
  // the remote itself pages through. The wording says what the page becomes,
  // not what is done to it, because the same menu item reads as the opposite
  // instruction on a page that is already a subpage.
  make_subpage: {
    en: "Make subpage", de: "Zu Unterseite machen", fr: "Convertir en sous-page",
    it: "Rendi sottopagina", es: "Convertir en subpágina",
  },
  make_mainpage: {
    en: "Make main page", de: "Zu Hauptseite machen", fr: "Convertir en page principale",
    it: "Rendi pagina principale", es: "Convertir en página principal",
  },
  duplicate_page: {
    en: "Duplicate page", de: "Seite duplizieren", fr: "Dupliquer la page",
    it: "Duplica pagina", es: "Duplicar página",
  },
  change_device: {
    en: "Change device…", de: "Gerät ändern…", fr: "Changer d'appareil…",
    it: "Cambia dispositivo…", es: "Cambiar dispositivo…",
  },
  change_hub: {
    en: "Change hub…", de: "Hub ändern…", fr: "Changer de hub…",
    it: "Cambia hub…", es: "Cambiar hub…",
  },
  change_device_confirm: {
    en: "Change device", de: "Gerät ändern", fr: "Changer d'appareil",
    it: "Cambia dispositivo", es: "Cambiar dispositivo",
  },
  change_hub_confirm: {
    en: "Change hub", de: "Hub ändern", fr: "Changer de hub",
    it: "Cambia hub", es: "Cambiar hub",
  },
  changing: {
    en: "Changing…", de: "Wird geändert…", fr: "Modification…",
    it: "Modifica in corso…", es: "Cambiando…",
  },
  device_changed: {
    en: "Page \"{name}\" now uses the new device: {n} button(s) updated",
    de: "Seite „{name}“ nutzt jetzt das neue Gerät: {n} Taste(n) angepasst",
    fr: "La page « {name} » utilise le nouvel appareil : {n} bouton(s) mis à jour",
    it: "La pagina \"{name}\" usa ora il nuovo dispositivo: {n} pulsante/i aggiornato/i",
    es: "La página \"{name}\" usa ahora el nuevo dispositivo: {n} botón(es) actualizado(s)",
  },
  // Same shape as device_changed, but a config-entry target is a hub, not a
  // device -- a page retargeted onto one was reporting "new device" in every
  // language regardless of which kind of target it actually got.
  hub_changed: {
    en: "Page \"{name}\" now uses the new hub: {n} button(s) updated",
    de: "Seite „{name}“ nutzt jetzt den neuen Hub: {n} Taste(n) angepasst",
    fr: "La page « {name} » utilise le nouveau hub : {n} bouton(s) mis à jour",
    it: "La pagina \"{name}\" usa ora il nuovo hub: {n} pulsante/i aggiornato/i",
    es: "La página \"{name}\" usa ahora el nuevo hub: {n} botón(es) actualizado(s)",
  },
  layout_gone: {
    en: "The layout \"{name}\" this page was made from is no longer available",
    de: "Das Layout „{name}“, aus dem diese Seite erstellt wurde, ist nicht mehr verfügbar",
    fr: "La mise en page « {name} » d'origine de cette page n'est plus disponible",
    it: "Il layout \"{name}\" da cui è stata creata questa pagina non è più disponibile",
    es: "El diseño \"{name}\" del que se creó esta página ya no está disponible",
  },
  page_duplicated: {
    en: "Page \"{name}\" duplicated", de: "Seite „{name}“ dupliziert",
    fr: "Page « {name} » dupliquée", it: "Pagina \"{name}\" duplicata",
    es: "Página \"{name}\" duplicada",
  },
  duplicate_page_failed: {
    en: "Could not duplicate the page: {error}",
    de: "Seite konnte nicht dupliziert werden: {error}",
    fr: "Impossible de dupliquer la page : {error}",
    it: "Impossibile duplicare la pagina: {error}",
    es: "No se ha podido duplicar la página: {error}",
  },
  move_left: {
    en: "Move left", de: "Nach links verschieben", fr: "Déplacer vers la gauche",
    it: "Sposta a sinistra", es: "Mover a la izquierda",
  },
  move_right: {
    en: "Move right", de: "Nach rechts verschieben", fr: "Déplacer vers la droite",
    it: "Sposta a destra", es: "Mover a la derecha",
  },
  page_default: {
    en: "Page default", de: "Seitenstandard", fr: "Valeur par défaut de la page",
    it: "Predefinito della pagina", es: "Predeterminado de la página",
  },
  a11y_editing: {
    en: "Editing {name}", de: "{name} wird bearbeitet", fr: "Modification de {name}",
    it: "Modifica di {name}", es: "Editando {name}",
  },
  a11y_editing_generic: {
    en: "Editing button", de: "Taste wird bearbeitet", fr: "Modification du bouton",
    it: "Modifica del pulsante", es: "Editando el botón",
  },
  a11y_editor_closed: {
    en: "Closed editor for {name}", de: "Editor für {name} geschlossen",
    fr: "Éditeur de {name} fermé", it: "Editor di {name} chiuso",
    es: "Editor de {name} cerrado",
  },
  a11y_editor_closed_generic: {
    en: "Closed button editor", de: "Tasteneditor geschlossen",
    fr: "Éditeur de bouton fermé", it: "Editor del pulsante chiuso",
    es: "Editor de botón cerrado",
  },
  a11y_config_region: {
    en: "Settings for {name}", de: "Einstellungen für {name}",
    fr: "Paramètres de {name}", it: "Impostazioni di {name}",
    es: "Ajustes de {name}",
  },
  a11y_config_region_generic: {
    en: "Button settings", de: "Tasteneinstellungen", fr: "Paramètres du bouton",
    it: "Impostazioni del pulsante", es: "Ajustes del botón",
  },
  a11y_page_region: {
    en: "Page settings", de: "Seiteneinstellungen", fr: "Paramètres de la page",
    it: "Impostazioni della pagina", es: "Ajustes de la página",
  },
  a11y_editing_title: {
    en: "Editing page title", de: "Seitentitel wird bearbeitet",
    fr: "Modification du titre de la page", it: "Modifica del titolo della pagina",
    es: "Editando el título de la página",
  },
  a11y_title_closed: {
    en: "Closed page title editor", de: "Seitentitel-Editor geschlossen",
    fr: "Éditeur du titre de la page fermé", it: "Editor del titolo della pagina chiuso",
    es: "Editor del título de la página cerrado",
  },

  // ── layouts ────────────────────────────────────────────────────────
  choose_layout: {
    en: "Choose layout", de: "Layout wählen", fr: "Choisir une disposition",
    it: "Scegli layout", es: "Elegir diseño",
  },
  choose_layout_device: {
    en: "Choose the device this layout will control.",
    de: "Wählen Sie das Gerät, das dieses Layout steuern soll.",
    fr: "Choisissez l'appareil que cette disposition va commander.",
    it: "Scegli il dispositivo che questo layout controllerà.",
    es: "Elija el dispositivo que controlará este diseño.",
  },
  configure_manually: {
    en: "Configure buttons manually", de: "Tasten manuell einrichten",
    fr: "Configurer les touches manuellement",
    it: "Configura i tasti manualmente",
    es: "Configurar los botones manualmente",
  },
  preconfigured_remote: {
    en: "Pre-configured device remote", de: "Vorkonfigurierte Gerätefernbedienung",
    fr: "Télécommande d'appareil préconfigurée",
    it: "Telecomando dispositivo preconfigurato",
    es: "Mando de dispositivo preconfigurado",
  },
  no_layouts: {
    en: "No layouts available", de: "Keine Layouts verfügbar",
    fr: "Aucune disposition disponible", it: "Nessun layout disponibile",
    es: "No hay diseños disponibles",
  },
  layout_added: {
    en: 'Layout "{name}" added ✓',
    de: "Layout „{name}“ hinzugefügt ✓",
    fr: "Disposition « {name} » ajoutée ✓",
    it: 'Layout "{name}" aggiunto ✓',
    es: "Diseño «{name}» añadido ✓",
  },
  layout_no_target: {
    en: "This layout declares no target selector and cannot be added.",
    de: "Dieses Layout deklariert keinen Zielselektor und kann nicht hinzugefügt werden.",
    fr: "Cette disposition ne déclare aucun sélecteur de cible et ne peut pas être ajoutée.",
    it: "Questo layout non dichiara alcun selettore di destinazione e non può essere aggiunto.",
    es: "Este diseño no declara ningún selector de destino y no se puede añadir.",
  },
  range_min: {
    en: "Min", de: "Min", fr: "Min", it: "Min", es: "Mín",
  },
  range_max: {
    en: "Max", de: "Max", fr: "Max", it: "Max", es: "Máx",
  },
  device_online: {
    en: "Online", de: "Online", fr: "En ligne", it: "Online", es: "En línea",
  },
  device_offline: {
    en: "Offline", de: "Offline", fr: "Hors ligne", it: "Offline", es: "Sin conexión",
  },
  // A third state: two could not tell "the device says it is down" apart from
  // "we never managed to ask", and announced aloud (4.1.3) that guess becomes
  // a spoken falsehood. One word, and no longer than es "Sin conexión" (12),
  // which is what the toolbar's reflow breakpoint was measured against.
  device_unknown: {
    en: "Unknown", de: "Unbekannt", fr: "Inconnu", it: "Sconosciuto", es: "Desconocido",
  },
  // What the live region says when the state changes. The bare word is what
  // the pill shows, but out of context "Offline" alone does not say offline
  // *what* -- and a status message arrives with no surrounding screen to read
  // it against, so it names the device it is about.
  device_status_announced: {
    en: "{name}: {state}", de: "{name}: {state}", fr: "{name} : {state}",
    it: "{name}: {state}", es: "{name}: {state}",
  },
  back: {
    en: "Back", de: "Zurück", fr: "Retour", it: "Indietro", es: "Atrás",
  },
  image_url: {
    en: "Image URL", de: "Bild-URL", fr: "URL de l'image",
    it: "URL dell'immagine", es: "URL de la imagen",
  },
  badge_unused: {
    en: "unused", de: "nicht verwendet", fr: "non utilisé",
    it: "non utilizzato", es: "sin usar",
  },
  a11y_usage_count: {
    en: "used by {n} buttons", de: "von {n} Tasten verwendet",
    fr: "utilisé par {n} touches", it: "usato da {n} tasti",
    es: "usado por {n} teclas",
  },
  a11y_state_icons: {
    en: "{n} state icons", de: "{n} Status-Symbole",
    fr: "{n} icônes d'état", it: "{n} icone di stato",
    es: "{n} iconos de estado",
  },
  target_hub: {
    en: "Target hub", de: "Ziel-Hub", fr: "Hub cible",
    it: "Hub di destinazione", es: "Hub de destino",
  },
  target_device: {
    en: "Target device", de: "Zielgerät", fr: "Appareil cible",
    it: "Dispositivo di destinazione", es: "Dispositivo de destino",
  },
  loading_hubs: {
    en: "Loading…", de: "Wird geladen…", fr: "Chargement…",
    it: "Caricamento…", es: "Cargando…",
  },
  loading_devices: {
    en: "Loading devices…", de: "Geräte werden geladen…",
    fr: "Chargement des appareils…", it: "Caricamento dispositivi…",
    es: "Cargando dispositivos…",
  },
  select_hub: {
    en: "Select hub…", de: "Hub wählen…", fr: "Choisir un hub…",
    it: "Seleziona hub…", es: "Seleccionar hub…",
  },
  // The link is a `{link}` slot rather than markup in the table: the URL then
  // lives in one place, and each language can put the link where its own
  // sentence wants it instead of at a position English happens to use.
  no_devices: {
    en: "No devices found. Add one via {link}.",
    de: "Keine Geräte gefunden. Über {link} hinzufügen.",
    fr: "Aucun appareil trouvé. Ajoutez-en via {link}.",
    it: "Nessun dispositivo trovato. Aggiungilo da {link}.",
    es: "No se han encontrado dispositivos. Añádalos en {link}.",
  },
  no_devices_link: {
    en: "Settings → Integrations",
    de: "Einstellungen → Integrationen",
    fr: "Paramètres → Intégrations",
    it: "Impostazioni → Integrazioni",
    es: "Ajustes → Integraciones",
  },

  // ── buttons ────────────────────────────────────────────────────────
  edit_this_button: {
    en: "Edit this button", de: "Diese Taste bearbeiten", fr: "Modifier cette touche",
    it: "Modifica questo tasto", es: "Editar este botón",
  },
  no_action_assigned: {
    en: "No action assigned", de: "Keine Aktion zugewiesen",
    fr: "Aucune action attribuée", it: "Nessuna azione assegnata",
    es: "Ninguna acción asignada",
  },
  not_assigned_to_button: {
    en: "Not assigned to any button", de: "Keiner Taste zugewiesen",
    fr: "Attribuée à aucune touche", it: "Non assegnata ad alcun tasto",
    es: "No asignada a ningún botón",
  },
  assigned_to: {
    en: "Assigned to", de: "Zugewiesen an", fr: "Attribuée à",
    it: "Assegnata a", es: "Asignada a",
  },
  unassign_all_confirm: {
    en: "Unassign all buttons on this page?",
    de: "Alle Tasten dieser Seite freigeben?",
    fr: "Libérer toutes les touches de cette page ?",
    it: "Rimuovere l'assegnazione di tutti i tasti di questa pagina?",
    es: "¿Desasignar todos los botones de esta página?",
  },
  different_scope: {
    en: "That button is configured in a different scope",
    de: "Diese Taste ist in einem anderen Gültigkeitsbereich konfiguriert",
    fr: "Cette touche est configurée dans une autre portée",
    it: "Quel tasto è configurato in un ambito diverso",
    es: "Ese botón está configurado en otro ámbito",
  },
  no_actions_yet: {
    en: "No actions yet. Assign actions to buttons in the {tab} tab.",
    de: "Noch keine Aktionen. Weisen Sie Tasten im Reiter {tab} Aktionen zu.",
    fr: "Aucune action pour l'instant. Attribuez des actions aux touches dans l'onglet {tab}.",
    it: "Ancora nessuna azione. Assegna azioni ai tasti nella scheda {tab}.",
    es: "Aún no hay acciones. Asigne acciones a los botones en la pestaña {tab}.",
  },

  // ── validation messages ────────────────────────────────────────────
  // Each says what a correct answer looks like, not just that it was wrong:
  // WCAG 3.3.3 asks for a suggestion where one is known.
  invalid_hex: {
    en: "Enter a 6-digit hex colour, for example 1A73E8.",
    de: "Sechsstelligen Hex-Farbwert eingeben, z. B. 1A73E8.",
    fr: "Saisissez une couleur hexadécimale à 6 chiffres, par exemple 1A73E8.",
    it: "Inserisci un colore esadecimale a 6 cifre, ad esempio 1A73E8.",
    es: "Introduce un color hexadecimal de 6 dígitos, por ejemplo 1A73E8.",
  },
  invalid_number: {
    en: "Enter a number.", de: "Zahl eingeben.",
    fr: "Saisissez un nombre.", it: "Inserisci un numero.",
    es: "Introduce un número.",
  },
  invalid_range: {
    en: "Enter a number between {min} and {max}.",
    de: "Zahl zwischen {min} und {max} eingeben.",
    fr: "Saisissez un nombre entre {min} et {max}.",
    it: "Inserisci un numero compreso tra {min} e {max}.",
    es: "Introduce un número entre {min} y {max}.",
  },
  invalid_min_max: {
    en: "Maximum must be greater than minimum.",
    de: "Maximum muss größer als Minimum sein.",
    fr: "Le maximum doit être supérieur au minimum.",
    it: "Il massimo deve essere maggiore del minimo.",
    es: "El máximo debe ser mayor que el mínimo.",
  },
  // ── colour ─────────────────────────────────────────────────────────
  color_hex: {
    en: "Icon color as hex value", de: "Symbolfarbe als Hex-Wert",
    fr: "Couleur d'icône en hexadécimal", it: "Colore icona in esadecimale",
    es: "Color de icono en hexadecimal",
  },
  pick_custom_color: {
    en: "Pick a custom color", de: "Eigene Farbe wählen",
    fr: "Choisir une couleur personnalisée", it: "Scegli un colore personalizzato",
    es: "Elegir un color personalizado",
  },
  clear_color: {
    en: "Clear color (follow theme)", de: "Farbe zurücksetzen (Theme folgen)",
    fr: "Effacer la couleur (suivre le thème)",
    it: "Cancella il colore (segui il tema)",
    es: "Borrar el color (seguir el tema)",
  },
  tints_icons: {
    en: "Tints icons on this page. Logos are not affected.",
    de: "Färbt die Symbole dieser Seite ein. Logos bleiben unberührt.",
    fr: "Colore les icônes de cette page. Les logos ne sont pas affectés.",
    it: "Colora le icone di questa pagina. I loghi non sono interessati.",
    es: "Tiñe los iconos de esta página. Los logotipos no se ven afectados.",
  },

  // ── tooltips and sliders ───────────────────────────────────────────
  save_tooltip: {
    en: "Save tooltip", de: "Kurzinfo speichern", fr: "Enregistrer l'infobulle",
    it: "Salva descrizione", es: "Guardar descripción",
  },
  reset_tooltip: {
    en: "Reset to auto-generated tooltip",
    de: "Auf automatisch erzeugte Kurzinfo zurücksetzen",
    fr: "Revenir à l'infobulle générée automatiquement",
    it: "Ripristina la descrizione generata automaticamente",
    es: "Restablecer la descripción generada automáticamente",
  },
  discard_change: {
    en: "Discard this change", de: "Diese Änderung verwerfen",
    fr: "Annuler cette modification", it: "Annulla questa modifica",
    es: "Descartar este cambio",
  },
  use_for_slider: {
    en: "Use for slider", de: "Für Schieberegler verwenden",
    fr: "Utiliser pour le curseur", it: "Usa per il cursore",
    es: "Usar para el control deslizante",
  },
  pinned_in_yaml: {
    en: "Pinned in YAML — no button retargets it.",
    de: "In YAML festgelegt — keine Taste lenkt ihn um.",
    fr: "Fixé dans le YAML — aucune touche ne le réoriente.",
    it: "Fissato nello YAML — nessun tasto lo ridirige.",
    es: "Fijado en YAML — ningún botón lo redirige.",
  },
  set_under_advanced: {
    en: "— set under Advanced —", de: "— unter Erweitert festgelegt —",
    fr: "— défini sous Avancé —", it: "— impostato in Avanzate —",
    es: "— definido en Avanzado —",
  },
  scale_mismatch: {
    en: "{entity} isn't available here — using {attribute} (0–255) but writing {service} (0–100) will misbehave.",
    de: "{entity} ist hier nicht verfügbar — {attribute} (0–255) zu lesen, aber {service} (0–100) zu schreiben, führt zu Fehlverhalten.",
    fr: "{entity} n'est pas disponible ici — lire {attribute} (0–255) mais écrire {service} (0–100) provoquera un dysfonctionnement.",
    it: "{entity} non è disponibile qui — leggere {attribute} (0–255) ma scrivere {service} (0–100) causerà malfunzionamenti.",
    es: "{entity} no está disponible aquí — leer {attribute} (0–255) pero escribir {service} (0–100) funcionará mal.",
  },

  // ── images and states ──────────────────────────────────────────────
  no_service_defined: {
    en: "No service defined. Assign this action to a button first.",
    de: "Kein Dienst definiert. Weisen Sie diese Aktion zuerst einer Taste zu.",
    fr: "Aucun service défini. Attribuez d'abord cette action à une touche.",
    it: "Nessun servizio definito. Assegna prima questa azione a un tasto.",
    es: "Ningún servicio definido. Asigne primero esta acción a un botón.",
  },

  // ── outcomes ───────────────────────────────────────────────────────
  saved: {
    en: "Saved ✓", de: "Gespeichert ✓", fr: "Enregistré ✓",
    it: "Salvato ✓", es: "Guardado ✓",
  },
  action_executed: {
    en: "Action executed ✓", de: "Aktion ausgeführt ✓", fr: "Action exécutée ✓",
    it: "Azione eseguita ✓", es: "Acción ejecutada ✓",
  },
  save_failed: {
    en: "Save failed: {error}", de: "Speichern fehlgeschlagen: {error}",
    fr: "Échec de l'enregistrement : {error}",
    it: "Salvataggio non riuscito: {error}",
    es: "Error al guardar: {error}",
  },
  failed: {
    en: "Failed: {error}", de: "Fehlgeschlagen: {error}",
    fr: "Échec : {error}", it: "Non riuscito: {error}",
    es: "Error: {error}",
  },
  add_page_failed: {
    en: "Failed to add page", de: "Seite konnte nicht hinzugefügt werden",
    fr: "Impossible d'ajouter la page", it: "Impossibile aggiungere la pagina",
    es: "No se ha podido añadir la página",
  },
  add_page_error: {
    en: "Error adding page: {error}",
    de: "Fehler beim Hinzufügen der Seite: {error}",
    fr: "Erreur lors de l'ajout de la page : {error}",
    it: "Errore durante l'aggiunta della pagina: {error}",
    es: "Error al añadir la página: {error}",
  },
  delete_page_failed: {
    en: "Failed to delete page", de: "Seite konnte nicht gelöscht werden",
    fr: "Impossible de supprimer la page", it: "Impossibile eliminare la pagina",
    es: "No se ha podido eliminar la página",
  },
  layout_picker_failed: {
    en: "Failed to open layout picker",
    de: "Layout-Auswahl konnte nicht geöffnet werden",
    fr: "Impossible d'ouvrir le sélecteur de disposition",
    it: "Impossibile aprire il selettore di layout",
    es: "No se ha podido abrir el selector de diseños",
  },
  // ── slider card ────────────────────────────────────────────────────
  advanced: {
    en: "Advanced", de: "Erweitert", fr: "Avancé", it: "Avanzate", es: "Avanzado",
  },
  customised: {
    en: "customised", de: "angepasst", fr: "personnalisé",
    it: "personalizzato", es: "personalizado",
  },
  control: {
    en: "Control", de: "Regelgröße", fr: "Commande", it: "Controllo", es: "Control",
  },
  data_key: {
    en: "Data key", de: "Datenschlüssel", fr: "Clé de données",
    it: "Chiave dati", es: "Clave de datos",
  },
  sensitivity: {
    en: "Sensitivity", de: "Empfindlichkeit", fr: "Sensibilité",
    it: "Sensibilità", es: "Sensibilidad",
  },
  label: {
    en: "Label", de: "Beschriftung", fr: "Libellé", it: "Etichetta", es: "Etiqueta",
  },
  tooltip: {
    en: "Tooltip", de: "Kurzinfo", fr: "Infobulle", it: "Descrizione", es: "Descripción",
  },
  reset_control_defaults: {
    en: "Reset to {control} defaults",
    de: "Auf Standardwerte für {control} zurücksetzen",
    fr: "Rétablir les valeurs par défaut de {control}",
    it: "Ripristina i valori predefiniti di {control}",
    es: "Restablecer los valores predeterminados de {control}",
  },
  slider_range_hint: {
    en: "Read from the entity when you first touch, and clamped to this range on the way out.",
    de: "Wird beim ersten Berühren aus der Entität gelesen und auf dem Weg hinaus auf diesen Bereich begrenzt.",
    fr: "Lu depuis l'entité au premier contact, puis ramené à cette plage en sortie.",
    it: "Letto dall'entità al primo tocco e limitato a questo intervallo in uscita.",
    es: "Se lee de la entidad al primer contacto y se limita a este intervalo al salir.",
  },
  slider_plumbing_hint: {
    en: "The plumbing behind the control above. Attribute and Data key must share a scale — reading <code>brightness</code> (0–255) but writing <code>brightness_pct</code> (0–100) will misbehave.",
    de: "Der Unterbau der Regelgröße oben. Attribut und Datenschlüssel müssen dieselbe Skala verwenden — <code>brightness</code> (0–255) zu lesen, aber <code>brightness_pct</code> (0–100) zu schreiben, führt zu Fehlverhalten.",
    fr: "La mécanique derrière la commande ci-dessus. L'attribut et la clé de données doivent partager la même échelle — lire <code>brightness</code> (0–255) mais écrire <code>brightness_pct</code> (0–100) provoquera un dysfonctionnement.",
    it: "Il meccanismo dietro il controllo qui sopra. Attributo e chiave dati devono condividere la stessa scala — leggere <code>brightness</code> (0–255) ma scrivere <code>brightness_pct</code> (0–100) causerà malfunzionamenti.",
    es: "La mecánica tras el control de arriba. El atributo y la clave de datos deben compartir la misma escala — leer <code>brightness</code> (0–255) pero escribir <code>brightness_pct</code> (0–100) funcionará mal.",
  },
  slider_page_mechanics_hint: {
    en: "These are the page's mechanics, not {name}'s: when a button retargets the slider the remote re-derives the whole set from the live entity on every gesture, so there is nothing per-button to store here. Editing them changes the <b>{page_default}</b>, from here or from there.",
    de: "Dies sind die Mechanismen der Seite, nicht die von {name}: Lenkt eine Taste den Schieberegler um, leitet die Fernbedienung den gesamten Satz bei jeder Geste neu aus der laufenden Entität ab — hier gibt es also nichts pro Taste zu speichern. Eine Änderung wirkt auf den <b>{page_default}</b>, von hier wie von dort.",
    fr: "Ce sont les mécanismes de la page, pas ceux de {name} : lorsqu'une touche réoriente le curseur, la télécommande redérive l'ensemble depuis l'entité active à chaque geste, il n'y a donc rien à stocker par touche ici. Les modifier change la <b>{page_default}</b>, d'ici comme de là-bas.",
    it: "Questi sono i meccanismi della pagina, non quelli di {name}: quando un tasto ridirige il cursore il telecomando rideriva l'intero insieme dall'entità attiva a ogni gesto, quindi qui non c'è nulla da memorizzare per tasto. Modificarli cambia il <b>{page_default}</b>, da qui come da lì.",
    es: "Esta es la mecánica de la página, no la de {name}: cuando un botón redirige el control deslizante, el mando vuelve a derivar todo el conjunto de la entidad activa en cada gesto, así que aquí no hay nada que guardar por botón. Editarlos cambia el <b>{page_default}</b>, desde aquí o desde allí.",
  },
  slider_entity_hint: {
    en: "What the slider drives until a button retargets it. Leave empty to do nothing until you touch a device.",
    de: "Was der Schieberegler steuert, bis eine Taste ihn umlenkt. Leer lassen, damit nichts geschieht, bis Sie ein Gerät berühren.",
    fr: "Ce que le curseur commande jusqu'à ce qu'une touche le réoriente. Laissez vide pour qu'il ne fasse rien tant que vous ne touchez pas un appareil.",
    it: "Ciò che il cursore comanda finché un tasto non lo ridirige. Lascia vuoto perché non faccia nulla finché non tocchi un dispositivo.",
    es: "Lo que acciona el control deslizante hasta que un botón lo redirige. Déjelo vacío para que no haga nada hasta que toque un dispositivo.",
  },
  slider_factor_hint: {
    en: "At 1.0, touching one end of the track reaches the full range and touching the middle reaches half. Raise it to cover the range in less travel.",
    de: "Bei 1,0 erreicht eine Berührung am Ende der Bahn den vollen Bereich, in der Mitte die Hälfte. Höhere Werte decken den Bereich mit kürzerem Weg ab.",
    fr: "À 1,0, toucher une extrémité de la piste atteint toute la plage et le milieu la moitié. Augmentez la valeur pour couvrir la plage sur une course plus courte.",
    it: "A 1,0, toccare un'estremità della traccia raggiunge l'intero intervallo e il centro la metà. Aumentalo per coprire l'intervallo con meno corsa.",
    es: "En 1,0, tocar un extremo de la pista alcanza todo el intervalo y el centro, la mitad. Auméntelo para cubrir el intervalo con menos recorrido.",
  },
  slider_use_page_factor: {
    en: "Use the page value ({value})", de: "Seitenwert verwenden ({value})",
    fr: "Utiliser la valeur de la page ({value})",
    it: "Usa il valore della pagina ({value})",
    es: "Usar el valor de la página ({value})",
  },
  slider_pinned_hint: {
    en: "This page pins its slider, so no button can retarget it. Clear the slider's own entity under <b>{page_default}</b> to let buttons drive it.",
    de: "Diese Seite legt ihren Schieberegler fest, keine Taste kann ihn umlenken. Löschen Sie die eigene Entität des Schiebereglers unter <b>{page_default}</b>, damit Tasten ihn steuern können.",
    fr: "Cette page fixe son curseur, aucune touche ne peut le réorienter. Effacez l'entité propre du curseur sous <b>{page_default}</b> pour que les touches puissent le commander.",
    it: "Questa pagina fissa il suo cursore, nessun tasto può ridirigerlo. Cancella l'entità propria del cursore sotto <b>{page_default}</b> per far sì che i tasti lo comandino.",
    es: "Esta página fija su control deslizante, ningún botón puede redirigirlo. Borre la entidad propia del control deslizante en <b>{page_default}</b> para que los botones puedan accionarlo.",
  },
  slider_points_here: {
    en: "Touching {name} points this slider here.",
    de: "Eine Berührung von {name} richtet diesen Schieberegler hierher.",
    fr: "Toucher {name} oriente ce curseur ici.",
    it: "Toccare {name} punta questo cursore qui.",
    es: "Tocar {name} dirige este control deslizante aquí.",
  },
  slider_empty_hint: {
    en: "Empty, so this button leaves the slider alone — <b>{page_default}</b> stands.",
    de: "Leer, diese Taste lässt den Schieberegler also unberührt — <b>{page_default}</b> gilt.",
    fr: "Vide, cette touche laisse donc le curseur tranquille — <b>{page_default}</b> s'applique.",
    it: "Vuoto, quindi questo tasto lascia stare il cursore — vale <b>{page_default}</b>.",
    es: "Vacío, así que este botón deja en paz el control deslizante — rige <b>{page_default}</b>.",
  },
  edit_page_default_title: {
    en: "Edit this button's page default instead",
    de: "Stattdessen den Seitenstandard dieser Taste bearbeiten",
    fr: "Modifier plutôt la valeur par défaut de la page pour cette touche",
    it: "Modifica invece il predefinito della pagina per questo tasto",
    es: "Editar en su lugar el predeterminado de la página de este botón",
  },
  // The card subtitle that says which page's selection this override belongs
  // to. The name is wrapped in <b> by the caller and passed in as the
  // placeholder rather than sitting in the template, because the word order
  // around it moves between languages -- in German the name lands before the
  // verb, so a <b> fixed in the English shape would emphasise the wrong span.
  context_when_selected: {
    en: "when {name} is selected",
    de: "wenn {name} ausgewählt ist",
    fr: "lorsque {name} est sélectionné",
    it: "quando {name} è selezionato",
    es: "cuando {name} está seleccionado",
  },

  // ── icon hints ─────────────────────────────────────────────────────
  icon_showing_none: {
    en: "Showing no icon.", de: "Es wird kein Symbol angezeigt.",
    fr: "Aucune icône affichée.", it: "Nessuna icona mostrata.",
    es: "No se muestra ningún icono.",
  },
  icon_clear_to_hide: {
    en: "Clear it to show no icon.", de: "Leeren, um kein Symbol anzuzeigen.",
    fr: "Effacez-la pour n'afficher aucune icône.",
    it: "Cancellala per non mostrare alcuna icona.",
    es: "Bórrelo para no mostrar ningún icono.",
  },
  icon_leave_empty: {
    en: "Leave empty to show no icon — a slider that follows the selection has no fixed control to borrow one from.",
    de: "Leer lassen, um kein Symbol anzuzeigen — ein Schieberegler, der der Auswahl folgt, hat keine feste Regelgröße, von der er eines borgen könnte.",
    fr: "Laissez vide pour n'afficher aucune icône — un curseur qui suit la sélection n'a pas de commande fixe à laquelle en emprunter une.",
    it: "Lascia vuoto per non mostrare alcuna icona — un cursore che segue la selezione non ha un controllo fisso da cui prenderne una.",
    es: "Déjelo vacío para no mostrar ningún icono — un control deslizante que sigue a la selección no tiene un control fijo del que tomar uno.",
  },
  icon_nothing_chosen: {
    en: "Nothing is chosen, so there is no control to borrow an icon from — pick one here, or set the slider's entity first.",
    de: "Es ist nichts gewählt, also gibt es keine Regelgröße, von der ein Symbol geborgt werden könnte — wählen Sie hier eines oder setzen Sie zuerst die Entität des Schiebereglers.",
    fr: "Rien n'est sélectionné, il n'y a donc aucune commande à laquelle emprunter une icône — choisissez-en une ici, ou définissez d'abord l'entité du curseur.",
    it: "Non è selezionato nulla, quindi non c'è un controllo da cui prendere un'icona — scegline una qui o imposta prima l'entità del cursore.",
    es: "No hay nada seleccionado, así que no hay ningún control del que tomar un icono — elija uno aquí o defina primero la entidad del control deslizante.",
  },
  label_own_hint: {
    en: "{name}'s own — leave empty for <b>{auto}</b>.",
    de: "Eigene von {name} — leer lassen für <b>{auto}</b>.",
    fr: "Propre à {name} — laissez vide pour <b>{auto}</b>.",
    it: "Propria di {name} — lascia vuoto per <b>{auto}</b>.",
    es: "Propia de {name} — déjelo vacío para <b>{auto}</b>.",
  },

  visual_editor_unavailable: {    en: "Visual editor unavailable. Visit Settings → Automations first, then reload this page.",
    de: "Visueller Editor nicht verfügbar. Rufen Sie zuerst Einstellungen → Automatisierungen auf und laden Sie diese Seite dann neu.",
    fr: "Éditeur visuel indisponible. Ouvrez d'abord Paramètres → Automatisations, puis rechargez cette page.",
    it: "Editor visuale non disponibile. Apri prima Impostazioni → Automazioni, poi ricarica questa pagina.",
    es: "Editor visual no disponible. Abra primero Ajustes → Automatizaciones y vuelva a cargar esta página.",
  },

  // ── icon field, under a context ────────────────────────────────────
  ctx_icon_own: {
    en: "{name}'s own — shown while it holds the slider. ",
    de: "Eigenes von {name} — wird angezeigt, solange es den Schieberegler hält. ",
    fr: "Propre à {name} — affichée tant qu'il détient le curseur. ",
    it: "Propria di {name} — mostrata finché tiene il cursore. ",
    es: "Propio de {name} — se muestra mientras mantiene el control deslizante. ",
  },
  ctx_icon_none: {
    en: "Showing no icon.", de: "Es wird kein Symbol angezeigt.",
    fr: "Aucune icône n'est affichée.", it: "Non viene mostrata alcuna icona.",
    es: "No se muestra ningún icono.",
  },
  ctx_icon_clear: {
    en: "Clear it to show no icon.", de: "Leeren, um kein Symbol anzuzeigen.",
    fr: "Videz le champ pour n'afficher aucune icône.",
    it: "Svuotalo per non mostrare alcuna icona.",
    es: "Vacíelo para no mostrar ningún icono.",
  },
  ctx_icon_empty: {
    en: "Leave empty to show no icon.", de: "Leer lassen, um kein Symbol anzuzeigen.",
    fr: "Laissez vide pour n'afficher aucune icône.",
    it: "Lascia vuoto per non mostrare alcuna icona.",
    es: "Déjelo vacío para no mostrar ningún icono.",
  },

  // ── sensitivity, slider presets, validation ────────────────────────
  factor_own_hint: {
    en: "{name} has its own; the page uses {page}.",
    de: "{name} hat einen eigenen; die Seite verwendet {page}.",
    fr: "{name} a le sien ; la page utilise {page}.",
    it: "{name} ha il proprio; la pagina usa {page}.",
    es: "{name} tiene el suyo; la página usa {page}.",
  },
  factor_inherited_hint: {
    en: "Inherited from the page. Change it to give {name} its own.",
    de: "Von der Seite geerbt. Ändern Sie ihn, um {name} einen eigenen zu geben.",
    fr: "Hérité de la page. Modifiez-le pour donner le sien à {name}.",
    it: "Ereditato dalla pagina. Modificalo per dare a {name} il proprio.",
    es: "Heredado de la página. Cámbielo para darle uno propio a {name}.",
  },
  pick_target_first: {
    en: "Pick a target entity first.",
    de: "Wählen Sie zuerst eine Ziel-Entität.",
    fr: "Choisissez d'abord une entité cible.",
    it: "Scegli prima un'entità di destinazione.",
    es: "Elija primero una entidad de destino.",
  },
  no_presets_for_domain: {
    en: "No presets for <code>{domain}</code> — configure it under Advanced.",
    de: "Keine Vorgaben für <code>{domain}</code> — richten Sie es unter Erweitert ein.",
    fr: "Aucun préréglage pour <code>{domain}</code> — configurez-le sous Avancé.",
    it: "Nessun preset per <code>{domain}</code> — configuralo in Avanzate.",
    es: "No hay valores predefinidos para <code>{domain}</code> — configúrelo en Avanzado.",
  },
  no_actions_match: {
    en: 'No actions match "{filter}"', de: "Keine Aktionen passen zu „{filter}“",
    fr: "Aucune action ne correspond à « {filter} »",
    it: 'Nessuna azione corrisponde a "{filter}"',
    es: "Ninguna acción coincide con «{filter}»",
  },
  action_deleted_pages_failed: {
    en: "Action deleted, but these pages could not be updated: {pages}",
    de: "Aktion gelöscht, aber diese Seiten konnten nicht aktualisiert werden: {pages}",
    fr: "Action supprimée, mais ces pages n'ont pas pu être mises à jour : {pages}",
    it: "Azione eliminata, ma non è stato possibile aggiornare queste pagine: {pages}",
    es: "Acción eliminada, pero no se han podido actualizar estas páginas: {pages}",
  },
  control_stale: {
    en: "<code>{stored}</code> isn't available here — using <b>{control}</b>, {min}–{max}.",
    de: "<code>{stored}</code> ist hier nicht verfügbar — es wird <b>{control}</b> verwendet, {min}–{max}.",
    fr: "<code>{stored}</code> n'est pas disponible ici — utilisation de <b>{control}</b>, {min}–{max}.",
    it: "<code>{stored}</code> non è disponibile qui — viene usato <b>{control}</b>, {min}–{max}.",
    es: "<code>{stored}</code> no está disponible aquí — se usa <b>{control}</b>, {min}–{max}.",
  },
  this_button_controls: {
    en: "This button controls", de: "Diese Taste steuert",
    fr: "Cette touche commande", it: "Questo tasto controlla",
    es: "Este botón controla",
  },
  unknown_entity: {
    en: "Unknown entity <code>{entity}</code>.",
    de: "Unbekannte Entität <code>{entity}</code>.",
    fr: "Entité inconnue <code>{entity}</code>.",
    it: "Entità sconosciuta <code>{entity}</code>.",
    es: "Entidad desconocida <code>{entity}</code>.",
  },
  control_unsupported: {
    en: "<b>{name}</b> does not support {control} — this slider will do nothing. Pick another control.",
    de: "<b>{name}</b> unterstützt {control} nicht — dieser Schieberegler tut nichts. Wählen Sie eine andere Regelgröße.",
    fr: "<b>{name}</b> ne prend pas en charge {control} — ce curseur ne fera rien. Choisissez une autre commande.",
    it: "<b>{name}</b> non supporta {control} — questo cursore non farà nulla. Scegli un altro controllo.",
    es: "<b>{name}</b> no admite {control} — este control deslizante no hará nada. Elija otro control.",
  },
  max_must_exceed_min: {
    en: "Max must be greater than Min, or the slider can never change anything.",
    de: "Max muss größer als Min sein, sonst kann der Schieberegler nie etwas ändern.",
    fr: "Max doit être supérieur à Min, sinon le curseur ne peut rien changer.",
    it: "Max deve essere maggiore di Min, altrimenti il cursore non può cambiare nulla.",
    es: "Máx debe ser mayor que Mín, de lo contrario el control deslizante nunca cambiará nada.",
  },
  // Two halves of one hint. The first is omitted while the template resolves to
  // nothing, so they are separate ids rather than a placeholder that would have
  // to carry its own trailing space and punctuation through five languages.
  label_now_reads: {
    en: "Now reads <b>{text}</b>. ", de: "Zeigt derzeit <b>{text}</b>. ",
    fr: "Affiche actuellement <b>{text}</b>. ",
    it: "Ora mostra <b>{text}</b>. ",
    es: "Ahora muestra <b>{text}</b>. ",
  },
  label_state_hint: {
    en: "<code>${STATE}</code> follows the entity — replace it to fix the wording.",
    de: "<code>${STATE}</code> folgt der Entität — ersetzen Sie es, um die Formulierung zu ändern.",
    fr: "<code>${STATE}</code> suit l'entité — remplacez-le pour corriger la formulation.",
    it: "<code>${STATE}</code> segue l'entità — sostituiscilo per correggere la formulazione.",
    es: "<code>${STATE}</code> sigue a la entidad — sustitúyalo para corregir la redacción.",
  },
  label_name_hint: {
    en: "<code>${NAME}</code> is replaced by what the button opens.",
    de: "<code>${NAME}</code> wird durch das ersetzt, was die Taste öffnet.",
    fr: "<code>${NAME}</code> est remplacé par ce que la touche ouvre.",
    it: "<code>${NAME}</code> viene sostituito da ciò che il tasto apre.",
    es: "<code>${NAME}</code> se sustituye por lo que abre el botón.",
  },
  tooltip_needs_action: {
    en: "Add an action first — a tooltip on its own is not stored.",
    de: "Fügen Sie zuerst eine Aktion hinzu — ein Tooltip allein wird nicht gespeichert.",
    fr: "Ajoutez d'abord une action — une infobulle seule n'est pas enregistrée.",
    it: "Aggiungi prima un'azione — un tooltip da solo non viene salvato.",
    es: "Añada primero una acción — una información sobre herramientas por sí sola no se guarda.",
  },

  // ── page targets that no longer resolve ────────────────────────────
  // The subtitle under an action in the library, not the warning on a button
  // that has none -- that one is `no_service_defined`, and sharing the id made
  // this shorter phrase silently win over the longer sentence.
  no_service_subtitle: {
    en: "No service defined", de: "Kein Dienst definiert",
    fr: "Aucun service défini", it: "Nessun servizio definito",
    es: "Ningún servicio definido",
  },
  goto_no_page: {
    en: "No page is selected, so this button will do nothing.",
    de: "Es ist keine Seite ausgewählt, daher tut diese Taste nichts.",
    fr: "Aucune page n'est sélectionnée, ce bouton ne fera donc rien.",
    it: "Non è selezionata alcuna pagina, quindi questo pulsante non farà nulla.",
    es: "No hay ninguna página seleccionada, por lo que este botón no hará nada.",
  },
  goto_name_id_disagree: {
    en: "No page called {name} has the id {id}. This button will do nothing until the two agree.",
    de: "Keine Seite namens {name} hat die Kennung {id}. Diese Taste tut nichts, bis beide übereinstimmen.",
    fr: "Aucune page nommée {name} n'a l'identifiant {id}. Ce bouton ne fera rien tant que les deux ne concordent pas.",
    it: "Nessuna pagina chiamata {name} ha l'id {id}. Questo pulsante non farà nulla finché i due non concordano.",
    es: "Ninguna página llamada {name} tiene el id {id}. Este botón no hará nada hasta que ambos coincidan.",
  },
  goto_name_gone: {
    en: "There is no page called {name} any more, so this button will do nothing.",
    de: "Es gibt keine Seite namens {name} mehr, daher tut diese Taste nichts.",
    fr: "Il n'y a plus de page nommée {name}, ce bouton ne fera donc rien.",
    it: "Non esiste più una pagina chiamata {name}, quindi questo pulsante non farà nulla.",
    es: "Ya no existe ninguna página llamada {name}, por lo que este botón no hará nada.",
  },
  goto_ambiguous_name: {
    en: "{count} pages are called {name}, so this button cannot tell which one you mean and will do nothing. Rename one, or pick the page again to store its id.",
    de: "{count} Seiten heißen {name}, daher kann diese Taste nicht erkennen, welche gemeint ist, und tut nichts. Benennen Sie eine um oder wählen Sie die Seite erneut, um ihre Kennung zu speichern.",
    fr: "{count} pages s'appellent {name}, ce bouton ne peut donc pas savoir laquelle vous voulez et ne fera rien. Renommez-en une, ou choisissez à nouveau la page pour enregistrer son identifiant.",
    it: "{count} pagine si chiamano {name}, quindi questo pulsante non può sapere quale intendi e non farà nulla. Rinominane una, oppure scegli di nuovo la pagina per salvarne l'id.",
    es: "{count} páginas se llaman {name}, por lo que este botón no puede saber cuál quiere y no hará nada. Cambie el nombre de una, o elija la página de nuevo para guardar su id.",
  },
  goto_id_gone: {
    en: "There is no page with the id {id} any more, so this button will do nothing.",
    de: "Es gibt keine Seite mit der Kennung {id} mehr, daher tut diese Taste nichts.",
    fr: "Il n'y a plus de page avec l'identifiant {id}, ce bouton ne fera donc rien.",
    it: "Non esiste più una pagina con l'id {id}, quindi questo pulsante non farà nulla.",
    es: "Ya no existe ninguna página con el id {id}, por lo que este botón no hará nada.",
  },

  // ── hub and device pickers ─────────────────────────────────────────
  hubs_load_failed: {
    en: "Could not load hubs: {error}", de: "Hubs konnten nicht geladen werden: {error}",
    fr: "Impossible de charger les hubs : {error}",
    it: "Impossibile caricare gli hub: {error}",
    es: "No se han podido cargar los concentradores: {error}",
  },
  no_hub_found: {
    en: "No {integration} hub found. Set up the {integration} integration first.",
    de: "Kein {integration}-Hub gefunden. Richten Sie zuerst die Integration {integration} ein.",
    fr: "Aucun hub {integration} trouvé. Configurez d'abord l'intégration {integration}.",
    it: "Nessun hub {integration} trovato. Configura prima l'integrazione {integration}.",
    es: "No se ha encontrado ningún concentrador {integration}. Configure primero la integración {integration}.",
  },
  // Stands in for a layout that does not name its integration. A placeholder
  // cannot carry this one: "the required integration" substituted into "Set up
  // the {integration} integration first" reads "the the required integration
  // integration", which is what it did before it was split in two.
  no_hub_found_generic: {
    en: "No hub found. Set up the required integration first.",
    de: "Kein Hub gefunden. Richten Sie zuerst die benötigte Integration ein.",
    fr: "Aucun hub trouvé. Configurez d'abord l'intégration requise.",
    it: "Nessun hub trovato. Configura prima l'integrazione richiesta.",
    es: "No se ha encontrado ningún concentrador. Configure primero la integración necesaria.",
  },
  hub_disabled: {
    en: "That hub is disabled. Enable it first, or pick another.",
    de: "Dieser Hub ist deaktiviert. Aktivieren Sie ihn zuerst oder wählen Sie einen anderen.",
    fr: "Ce hub est désactivé. Activez-le d'abord, ou choisissez-en un autre.",
    it: "Questo hub è disattivato. Attivalo prima, oppure scegline un altro.",
    es: "Ese concentrador está desactivado. Actívelo primero o elija otro.",
  },
  hub_every_light: {
    en: "Every light on this hub gets a button.",
    de: "Jede Leuchte an diesem Hub erhält eine Taste.",
    fr: "Chaque lumière de ce hub reçoit un bouton.",
    it: "Ogni luce su questo hub riceve un pulsante.",
    es: "Cada luz de este concentrador recibe un botón.",
  },
  hub_choose: {
    en: "Choose the hub whose lights this page will control.",
    de: "Wählen Sie den Hub, dessen Leuchten diese Seite steuern soll.",
    fr: "Choisissez le hub dont cette page commandera les lumières.",
    it: "Scegli l'hub le cui luci questa pagina controllerà.",
    es: "Elija el concentrador cuyas luces controlará esta página.",
  },
  devices_load_failed: {
    en: "Could not load devices: {error}",
    de: "Geräte konnten nicht geladen werden: {error}",
    fr: "Impossible de charger les appareils : {error}",
    it: "Impossibile caricare i dispositivi: {error}",
    es: "No se han podido cargar los dispositivos: {error}",
  },
  no_matching_devices: {
    en: "No matching devices found. Set up the {integration} integration first.",
    de: "Keine passenden Geräte gefunden. Richten Sie zuerst die Integration {integration} ein.",
    fr: "Aucun appareil correspondant trouvé. Configurez d'abord l'intégration {integration}.",
    it: "Nessun dispositivo corrispondente trovato. Configura prima l'integrazione {integration}.",
    es: "No se han encontrado dispositivos coincidentes. Configure primero la integración {integration}.",
  },
  no_matching_devices_generic: {
    en: "No matching devices found. Set up the required integration first.",
    de: "Keine passenden Geräte gefunden. Richten Sie zuerst die benötigte Integration ein.",
    fr: "Aucun appareil correspondant trouvé. Configurez d'abord l'intégration requise.",
    it: "Nessun dispositivo corrispondente trovato. Configura prima l'integrazione richiesta.",
    es: "No se han encontrado dispositivos coincidentes. Configure primero la integración necesaria.",
  },

  // ── confirmations and tooltips ─────────────────────────────────────
  // The name goes in the title, not the body. Repeating "Delete page" in both
  // made the dialog say the same thing twice; the title asks the question and
  // the body is left to say only what is lost, which is the part WCAG 3.3.4
  // actually cares about.
  delete_page_title: {
    en: 'Delete "{name}"?',
    de: "„{name}“ löschen?",
    fr: "Supprimer « {name} » ?",
    it: "Eliminare \"{name}\"?",
    es: "¿Eliminar «{name}»?",
  },
  // Two messages rather than one with a count of zero: "and its 0 configured
  // buttons" reads as a bug, and 3.3.4 asks that the user be told what they
  // are destroying, not that every deletion sound equally grave.
  delete_page_confirm: {
    en: "This page and its {n} configured button(s) will be permanently deleted.",
    de: "Diese Seite und ihre {n} konfigurierte(n) Taste(n) werden endgültig gelöscht.",
    fr: "Cette page et ses {n} touche(s) configurée(s) seront définitivement supprimées.",
    it: "Questa pagina e i suoi {n} tasto/i configurato/i verranno eliminati definitivamente.",
    es: "Esta página y sus {n} botón(es) configurado(s) se eliminarán permanentemente.",
  },
  delete_page_confirm_empty: {
    en: "This page will be permanently deleted.",
    de: "Diese Seite wird endgültig gelöscht.",
    fr: "Cette page sera définitivement supprimée.",
    it: "Questa pagina verrà eliminata definitivamente.",
    es: "Esta página se eliminará permanentemente.",
  },
  page_deleted: {
    en: 'Page "{name}" deleted',
    de: "Seite „{name}“ gelöscht",
    fr: "Page « {name} » supprimée",
    it: "Pagina \"{name}\" eliminata",
    es: "Página «{name}» eliminada",
  },
  delete_action_confirm: {
    en: 'Delete action "{name}"?',
    de: "Aktion „{name}“ löschen?",
    fr: "Supprimer l'action « {name} » ?",
    it: "Eliminare l'azione \"{name}\"?",
    es: "¿Eliminar la acción «{name}»?",
  },
  default_is: {
    en: "Default: {value}", de: "Standard: {value}", fr: "Par défaut : {value}",
    it: "Predefinito: {value}", es: "Predeterminado: {value}",
  },

  // ── names for assistive technology ─────────────────────────────────
  // Read aloud, not shown. The face reports "configured" with colour, which a
  // screen reader cannot convey, so the state has to join the name.
  a11y_btn_configured: {
    en: "{name}, assigned", de: "{name}, belegt",
    fr: "{name}, attribuée", it: "{name}, assegnato",
    es: "{name}, asignado",
  },
  a11y_btn_empty: {
    en: "{name}, not assigned", de: "{name}, nicht belegt",
    fr: "{name}, non attribuée", it: "{name}, non assegnato",
    es: "{name}, sin asignar",
  },
  // A button with no label of its own is named from its key, which alone is a
  // bare token: a reader said "9" or "power" and "Settings for 9" afterwards.
  // Only the fallback is prefixed -- a name the user chose is used as given.
  a11y_btn_fallback: {
    en: "Button {name}", de: "Taste {name}", fr: "Touche {name}",
    it: "Tasto {name}", es: "Botón {name}",
  },
  // The vertical slider. Drawn by the same loop as the shapes, so it used to
  // take the "Button {name}" fallback and was announced "Button Slider
  // vertical" -- the storage key, and the wrong control word for a slider.
  a11y_slider: {
    en: "Slider", de: "Schieberegler", fr: "Curseur",
    it: "Cursore", es: "Control deslizante",
  },
  // The title strip. It sits on the face among the buttons and is drawn by the
  // same loop, but it is the Page Settings control and not a button, so the
  // "configured / empty" phrasing the shapes get would describe it wrongly --
  // there is nothing to assign to it.
  a11y_page_title: {
    en: "Page title", de: "Seitentitel", fr: "Titre de la page",
    it: "Titolo della pagina", es: "Título de la página",
  },
  // Both the thumbnail's tooltip and its accessible name. It was English-only
  // while it was "just a tooltip"; naming the control with it made that a
  // real barrier rather than an inconsistency.
  page_fill: {
    en: "{name} — {filled} of {total} buttons assigned, page {n} of {m}",
    de: "{name} — {filled} von {total} Tasten belegt, Seite {n} von {m}",
    fr: "{name} — {filled} touches sur {total} attribuées, page {n} sur {m}",
    it: "{name} — {filled} di {total} tasti assegnati, pagina {n} di {m}",
    es: "{name} — {filled} de {total} botones asignados, página {n} de {m}",
  },
  // The name a reader hears: which page, and where it sits. The fill count is
  // deliberately NOT here -- it is supplementary, so it rides on
  // aria-describedby instead and a reader can skip past it. `page_fill` above
  // stays whole because a hover tooltip has no way to offer that choice.
  page_name_pos: {
    en: "{name}, page {n} of {m}",
    de: "{name}, Seite {n} von {m}",
    fr: "{name}, page {n} sur {m}",
    it: "{name}, pagina {n} di {m}",
    es: "{name}, página {n} de {m}",
  },
  // The supplementary half, announced after the name and skippable.
  page_fill_desc: {
    en: "{filled} of {total} buttons assigned",
    de: "{filled} von {total} Tasten belegt",
    fr: "{filled} touches sur {total} attribuées",
    it: "{filled} di {total} tasti assegnati",
    es: "{filled} de {total} botones asignados",
  },
  // The page counter under the title strip. Trivial-looking, but "of" is not
  // the same word in five languages and it sits inside a `lang`-scoped tree,
  // so leaving it English had it announced as German on a German install.
  page_n_of_m: {
    en: "{n} of {m}", de: "{n} von {m}", fr: "{n} sur {m}",
    it: "{n} di {m}", es: "{n} de {m}",
  },
  // "Open {name}", not "Open page {name}": the name already carries the word
  // when it falls back to page_fallback, and said "Open page Page 1".
  a11y_open_page: {
    en: "Open {name}", de: "{name} öffnen", fr: "Ouvrir {name}",
    it: "Apri {name}", es: "Abrir {name}",
  },
  a11y_delete_page: {
    en: "Delete {name}", de: "{name} löschen", fr: "Supprimer {name}",
    it: "Elimina {name}", es: "Eliminar {name}",
  },
  // Folded into a page's spoken name so a subpage announces itself the same
  // way it names itself elsewhere ("make_subpage" / "Unterseite").
  a11y_subpage: {
    en: "subpage", de: "Unterseite", fr: "sous-page",
    it: "sottopagina", es: "subpágina",
  },
  // The name of a page with no title of its own. Was a hardcoded English
  // "Page N" inside a lang-scoped tree, so a German reader spoke it as German.
  page_fallback: {
    en: "Page {n}", de: "Seite {n}", fr: "Page {n}",
    it: "Pagina {n}", es: "Página {n}",
  },
};

/** The five languages we carry; anything else falls back to English. */
export const LANGS = ["en", "de", "fr", "it", "es"];

export const I18nMixin = {
  /** The base language Home Assistant is set to, e.g. `de` for `de-DE`. */
  _lang() {
    const raw = this._hass?.locale?.language || this._hass?.language || "en";
    const base = String(raw).toLowerCase().split(/[-_]/)[0];
    return LANGS.includes(base) ? base : "en";
  },

  /**
   * One user-visible phrase, translated and filled in.
   *
   * Home Assistant is asked first and believed only when it answers: an
   * unloaded fragment returns "", and silently rendering that would blank the
   * label rather than fall back. Unknown ids return the id itself, which is
   * ugly on screen on purpose — a blank is easy to miss in review.
   */
  /** A message that names the thing when there is a name, and falls back to the
   *  `<id>_generic` wording when there is not -- rather than interpolating an
   *  empty string and announcing "Editing ". */
  _tNamed(id, name) {
    return name ? this._t(id, { name }) : this._t(`${id}_generic`);
  },

  _t(id, vars) {
    const entry = STRINGS[id];
    let text = "";
    if (entry?.ha) {
      const answer = this._hass?.localize?.(entry.ha);
      if (typeof answer === "string" && answer) text = answer;
    }
    if (!text) text = entry ? (entry[this._lang()] || entry.en || id) : id;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.split(`{${name}}`).join(String(value ?? ""));
      }
    }
    return text;
  },
};
