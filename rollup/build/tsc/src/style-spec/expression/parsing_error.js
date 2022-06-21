class ParsingError extends Error {
    constructor(key, message) {
        super(message);
        this.message = message;
        this.key = key;
    }
}
export default ParsingError;
//# sourceMappingURL=parsing_error.js.map