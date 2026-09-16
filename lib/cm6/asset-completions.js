// CM6 CompletionSource for asset-engine's own scripting DSL ("%Path" / bare
// dotted-path asset attribute references). Deliberately calls the EXISTING,
// unmodified window.KufayekaIntellisense.getAttributeItemsDetailed()
// (lib/asset-plugin.html) — that's the real, already-working, live
// asset-hierarchy-aware data source behind today's Monaco/Ace autocomplete
// (registerMonacoCompleters/registerAceCompleters, same file) — this is
// just a CM6-shaped rendering of the same data, not a reimplementation.
// window.KufayekaIntellisense keeps registering against Monaco/Ace too
// (untouched) since that still benefits any OTHER Monaco/Ace editor on the
// same admin page (e.g. the core Function node) — this is purely additive.
export function assetPathCompletionSource(context) {
    var word = context.matchBefore(/[%$]?[\w.]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;

    var intellisense = window.KufayekaIntellisense;
    if (!intellisense || !intellisense.getAttributeItemsDetailed) return null;
    var items = intellisense.getAttributeItemsDetailed();
    if (!items.length) return null;

    var options = [];
    items.forEach(function (item) {
        var displayVal = item.value !== undefined ? String(item.value) : "undefined";
        var infoText = "Current: " + displayVal + (item.unit ? " " + item.unit : "") + "\nType: " + item.valueType +
            (item.description ? "\n" + item.description : "") + (item.ts ? "\n" + item.ts : "");

        options.push({
            label: "%" + item.path,
            type: "variable",
            detail: "[" + (item.unit || item.valueType) + "] " + displayVal,
            info: infoText,
            boost: 1
        });
        options.push({
            label: item.path,
            type: "property",
            detail: "[" + item.valueType + "] " + displayVal,
            info: infoText
        });
    });

    return { from: word.from, options: options, validFor: /^[%$]?[\w.]*$/ };
}
