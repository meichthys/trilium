import server from "../services/server.js";
import ws from "../services/ws.js";
import treeService from "../services/tree.js";
import noteAutocompleteService from "../services/note_autocomplete.js";
import TabAwareWidget from "./tab_aware_widget.js";

const TPL = `
<div class="promoted-attributes-wrapper">
    <style>
    .promoted-attributes-wrapper {
        margin: auto;
        /* setting the display to block since "table" doesn't support scrolling */
        display: block;
        /** flex-basis: content; - use once "content" is implemented by chrome */
        flex-shrink: 0;
        flex-grow: 0;
        overflow: auto;
        max-height: 400px;
    }
    
    .promoted-attributes td, .promoted-attributes th {
        padding: 5px;
        min-width: 50px; /* otherwise checkboxes can collapse into 0 width (if there are only checkboxes) */
    }
    </style>
    
    <table class="promoted-attributes"></table>
</div>
`;

export default class PromotedAttributesWidget extends TabAwareWidget {
    doRender() {
        this.$widget = $(TPL);

        this.$container = this.$widget.find(".promoted-attributes");
    }

    async refreshWithNote(note) {
        this.$container.empty();

        const attributes = note.getAttributes();

        const promoted = attributes
            .filter(attr => attr.isDefinition())
            .filter(attr => {
                const def = attr.getDefinition();

                return def && def.isPromoted;
            });

        if (promoted.length > 0 && !note.hasLabel('hidePromotedAttributes')) {
            const $tbody = $("<tbody>");

            for (const definitionAttr of promoted) {
                const definitionType = definitionAttr.name.startsWith('label:') ? 'label' : 'relation';
                const valueName = definitionAttr.name.substr(definitionType.length + 1);

                let valueAttrs = attributes.filter(el => el.name === valueName && el.type === 'label');

                if (valueAttrs.length === 0) {
                    valueAttrs.push({
                        attributeId: "",
                        type: definitionType,
                        name: valueName,
                        value: ""
                    });
                }

                if (definitionAttr.value.multiplicity === 'single') {
                    valueAttrs = valueAttrs.slice(0, 1);
                }

                for (const valueAttr of valueAttrs) {
                    const $tr = await this.createPromotedAttributeRow(definitionAttr, valueAttr, valueName);

                    $tbody.append($tr);
                }
            }

            // we replace the whole content in one step so there can't be any race conditions
            // (previously we saw promoted attributes doubling)
            this.$container.empty().append($tbody);
            this.toggleInt(true);
        }
        else {
            this.toggleInt(false);
        }

        return attributes;
    }

    async createPromotedAttributeRow(definitionAttr, valueAttr, valueName) {
        const definition = definitionAttr.getDefinition();
        const $tr = $("<tr>");
        const $labelCell = $("<th>").append(valueName);
        const $input = $("<input>")
            .prop("tabindex", 200 + definitionAttr.position)
            .prop("attribute-id", valueAttr.noteId === this.noteId ? valueAttr.attributeId : '') // if not owned, we'll force creation of a new attribute instead of updating the inherited one
            .prop("attribute-type", valueAttr.type)
            .prop("attribute-name", valueAttr.name)
            .prop("value", valueAttr.value)
            .addClass("form-control")
            .addClass("promoted-attribute-input")
            .on('change', event => this.promotedAttributeChanged(event));

        const $inputCell = $("<td>").append($("<div>").addClass("input-group").append($input));

        const $actionCell = $("<td>");
        const $multiplicityCell = $("<td>")
            .addClass("multiplicity")
            .attr("nowrap", true);

        $tr
            .append($labelCell)
            .append($inputCell)
            .append($actionCell)
            .append($multiplicityCell);

        if (valueAttr.type === 'label') {
            if (definition.labelType === 'text') {
                $input.prop("type", "text");

                // no need to await for this, can be done asynchronously
                server.get('attributes/values/' + encodeURIComponent(valueAttr.name)).then(attributeValues => {
                    if (attributeValues.length === 0) {
                        return;
                    }

                    attributeValues = attributeValues.map(attribute => ({ value: attribute }));

                    $input.autocomplete({
                        appendTo: document.querySelector('body'),
                        hint: false,
                        autoselect: false,
                        openOnFocus: true,
                        minLength: 0,
                        tabAutocomplete: false
                    }, [{
                        displayKey: 'value',
                        source: function (term, cb) {
                            term = term.toLowerCase();

                            const filtered = attributeValues.filter(attr => attr.value.toLowerCase().includes(term));

                            cb(filtered);
                        }
                    }]);

                    $input.on('autocomplete:selected', e => this.promotedAttributeChanged(e))
                });
            }
            else if (definition.labelType === 'number') {
                $input.prop("type", "number");

                let step = 1;

                for (let i = 0; i < (definition.numberPrecision || 0) && i < 10; i++) {
                    step /= 10;
                }

                $input.prop("step", step);
            }
            else if (definition.labelType === 'boolean') {
                $input.prop("type", "checkbox");

                if (valueAttr.value === "true") {
                    $input.prop("checked", "checked");
                }
            }
            else if (definition.labelType === 'date') {
                $input.prop("type", "date");
            }
            else if (definition.labelType === 'url') {
                $input.prop("placeholder", "http://website...");

                const $openButton = $("<span>")
                    .addClass("input-group-text open-external-link-button bx bx-trending-up")
                    .prop("title", "Open external link")
                    .on('click', () => window.open($input.val(), '_blank'));

                $input.after($("<div>")
                    .addClass("input-group-append")
                    .append($openButton));
            }
            else {
                ws.logError("Unknown labelType=" + definitionAttr.labelType);
            }
        }
        else if (valueAttr.type === 'relation') {
            if (valueAttr.value) {
                $input.val(await treeService.getNoteTitle(valueAttr.value));
            }

            // no need to wait for this
            noteAutocompleteService.initNoteAutocomplete($input);

            $input.on('autocomplete:selected', (event, suggestion, dataset) => {
                this.promotedAttributeChanged(event);
            });

            $input.setSelectedNotePath(valueAttr.value);
        }
        else {
            ws.logError("Unknown attribute type=" + valueAttr.type);
            return;
        }

        if (definition.multiplicity === "multivalue") {
            const addButton = $("<span>")
                .addClass("bx bx-plus pointer")
                .prop("title", "Add new attribute")
                .on('click', async () => {
                    const $new = await this.createPromotedAttributeRow(definitionAttr, {
                        attributeId: "",
                        type: valueAttr.type,
                        name: definitionAttr.name,
                        value: ""
                    });

                    $tr.after($new);

                    $new.find('input').trigger('focus');
                });

            const removeButton = $("<span>")
                .addClass("bx bx-trash pointer")
                .prop("title", "Remove this attribute")
                .on('click', async () => {
                    if (valueAttr.attributeId) {
                        await server.remove("notes/" + this.noteId + "/attributes/" + valueAttr.attributeId, this.componentId);
                    }

                    $tr.remove();
                });

            $multiplicityCell.append(addButton).append(" &nbsp;").append(removeButton);
        }

        return $tr;
    }

    async promotedAttributeChanged(event) {
        const $attr = $(event.target);

        let value;

        if ($attr.prop("type") === "checkbox") {
            value = $attr.is(':checked') ? "true" : "false";
        }
        else if ($attr.prop("attribute-type") === "relation") {
            const selectedPath = $attr.getSelectedNotePath();

            value = selectedPath ? treeService.getNoteIdFromNotePath(selectedPath) : "";
        }
        else {
            value = $attr.val();
        }

        const result = await server.put(`notes/${this.noteId}/attribute`, {
            attributeId: $attr.prop("attribute-id"),
            type: $attr.prop("attribute-type"),
            name: $attr.prop("attribute-name"),
            value: value
        }, this.componentId);

        $attr.prop("attribute-id", result.attributeId);
    }

    entitiesReloadedEvent({loadResults}) {
        if (loadResults.getAttributes(this.componentId).find(attr => attr.isAffecting(this.note))) {
            this.refresh();
        }
    }
}
