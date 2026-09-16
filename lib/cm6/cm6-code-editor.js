import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";

// CodeMirror 6 — deliberately NOT RED.editor.createEditor (ace/monaco). Node
// Dashboard's sibling package (@kufayeka/node-red-nexa-dashboard) hit a
// severe Ctrl+A -> Ctrl+C -> Ctrl+V freeze in Monaco that survived three
// targeted fixes; CM6 replaced it there for the same reason it's used here:
// a fundamentally simpler architecture than Monaco (no shared global
// mutable TypeScript compiler-options state, no language-service worker),
// so it isn't in the same risk class. No TypeScript type-checking here —
// CM6's javascript() is a parser/highlighter, not a language service — that
// mirrors what Monaco/Ace actually provided for this node too (the existing
// KufayekaIntellisense system is autocomplete-only, no red-squiggle type
// checking), so this isn't a feature regression.
//
// This is asset-engine's OWN copy of this wrapper (not shared with
// node-red-nexa-dashboard's near-identical module) — the two plugin
// packages have no workspace/build-order linking set up between them, so
// duplicating this ~150-line file keeps each package independently
// buildable rather than introducing that wiring for a small amount of
// shared code.
function themeExtension() {
    return EditorView.theme({
        "&": {
            color: "var(--red-ui-primary-text-color, #333)",
            backgroundColor: "var(--red-ui-primary-background, #fff)",
            border: "1px solid var(--red-ui-secondary-border-color, #ccc)",
            height: "100%"
        },
        "&.cm-focused": {
            outline: "none",
            borderColor: "var(--red-ui-primary-border-color, #3379b7)"
        },
        ".cm-content": {
            fontFamily: "Consolas, Monaco, monospace",
            fontSize: "13px"
        },
        ".cm-gutters": {
            backgroundColor: "var(--red-ui-secondary-background, #f7f7f9)",
            color: "var(--red-ui-tertiary-text-color, #999)",
            border: "none"
        },
        ".cm-scroller": { overflow: "auto" }
    });
}

function baseExtensions(completionSource) {
    var keymaps = [...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab];
    var extensions = [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        javascript(),
        keymap.of(keymaps),
        themeExtension(),
        EditorView.lineWrapping
    ];
    extensions.push(completionSource ? autocompletion({ override: [completionSource] }) : autocompletion());
    return extensions;
}

// options: { parent, value, completionSource, onChange }
// returns: { getValue(), setValue(v), focus(), resize(), destroy() }
export function createCM6Editor(options) {
    var onChange = options.onChange;
    var state = EditorState.create({
        doc: options.value || "",
        extensions: [
            ...baseExtensions(options.completionSource),
            EditorView.updateListener.of(function (update) {
                if (update.docChanged && onChange) onChange(update.state.doc.toString());
            })
        ]
    });

    var view = new EditorView({ state: state, parent: options.parent });

    return {
        getValue: function () { return view.state.doc.toString(); },
        setValue: function (v) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v || "" } });
        },
        focus: function () { view.focus(); },
        resize: function () { /* CM6 sizes off its parent element via CSS — nothing to do */ },
        destroy: function () { view.destroy(); }
    };
}

// A full-viewport modal wrapping one createCM6Editor instance, standing in
// for RED.editor.editJavaScript()'s "expand" dialog — that kernel feature is
// itself Monaco/Ace underneath, so calling it from here would quietly bring
// the exact freeze risk this migration exists to remove back in through the
// one button most likely to see a big Ctrl+A/Ctrl+C/Ctrl+V paste.
// options: { value, completionSource, onComplete(value), onCancel() }
export function openFullscreenCM6Editor(options) {
    var overlay = window.$("<div>").css({
        position: "fixed", top: 0, left: 0, right: 0, bottom: 0, "z-index": 10000,
        background: "var(--red-ui-primary-background, #fff)",
        display: "flex", "flex-direction": "column"
    }).appendTo(document.body);

    var toolbar = window.$("<div>").css({
        display: "flex", "justify-content": "flex-end", gap: "8px", padding: "8px 12px",
        "border-bottom": "1px solid var(--red-ui-secondary-border-color, #ddd)", "flex-shrink": "0"
    }).appendTo(overlay);

    var editorContainer = window.$("<div>").css({ flex: "1 1 auto", overflow: "hidden" }).appendTo(overlay);

    var editor = createCM6Editor({
        parent: editorContainer.get(0),
        value: options.value || "",
        completionSource: options.completionSource
    });

    function close() { editor.destroy(); overlay.remove(); }

    window.$("<button>", { type: "button", "class": "red-ui-button" }).text("Cancel").on("click", function () {
        close();
        if (options.onCancel) options.onCancel();
    }).appendTo(toolbar);
    window.$("<button>", { type: "button", "class": "red-ui-button primary" }).text("Done").on("click", function () {
        var value = editor.getValue();
        close();
        if (options.onComplete) options.onComplete(value);
    }).appendTo(toolbar);

    editor.focus();
    return { close: close };
}
