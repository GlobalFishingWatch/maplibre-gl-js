export class FormattedSection {
    constructor(text, image, scale, fontStack, textColor) {
        this.text = text;
        this.image = image;
        this.scale = scale;
        this.fontStack = fontStack;
        this.textColor = textColor;
    }
}
export default class Formatted {
    constructor(sections) {
        this.sections = sections;
    }
    static fromString(unformatted) {
        return new Formatted([new FormattedSection(unformatted, null, null, null, null)]);
    }
    isEmpty() {
        if (this.sections.length === 0)
            return true;
        return !this.sections.some(section => section.text.length !== 0 ||
            (section.image && section.image.name.length !== 0));
    }
    static factory(text) {
        if (text instanceof Formatted) {
            return text;
        }
        else {
            return Formatted.fromString(text);
        }
    }
    toString() {
        if (this.sections.length === 0)
            return '';
        return this.sections.map(section => section.text).join('');
    }
    serialize() {
        const serialized = ['format'];
        for (const section of this.sections) {
            if (section.image) {
                serialized.push(['image', section.image.name]);
                continue;
            }
            serialized.push(section.text);
            const options = {};
            if (section.fontStack) {
                options['text-font'] = ['literal', section.fontStack.split(',')];
            }
            if (section.scale) {
                options['font-scale'] = section.scale;
            }
            if (section.textColor) {
                options['text-color'] = ['rgba'].concat(section.textColor.toArray());
            }
            serialized.push(options);
        }
        return serialized;
    }
}
//# sourceMappingURL=formatted.js.map