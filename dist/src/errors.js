export class MantleMcpError extends Error {
    code;
    suggestion;
    details;
    constructor(code, message, suggestion, details = null) {
        super(message);
        this.code = code;
        this.suggestion = suggestion;
        this.details = details;
    }
}
export function toErrorPayload(error) {
    if (error instanceof MantleMcpError) {
        return {
            error: true,
            code: error.code,
            message: error.message,
            suggestion: error.suggestion,
            details: error.details
        };
    }
    return {
        error: true,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
        suggestion: "Retry the operation or check server logs.",
        details: null
    };
}
