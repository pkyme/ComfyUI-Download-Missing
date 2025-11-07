// Shared constants for the Download Missing UI

export const COLORS = {
    PRIMARY_GREEN: '#28a745',
    PRIMARY_GREEN_HOVER: '#218838',
    PRIMARY_GREEN_ACTIVE: '#1e7e34',
    PRIMARY_BLUE: '#0066cc',
    PRIMARY_BLUE_HOVER: '#0052a3',
    PRIMARY_BLUE_ACTIVE: '#004080',
    ERROR_RED: '#f44',
    WARNING_ORANGE: '#fa4',
    DARK_BG: '#1a1a1a',
    BORDER_GRAY: '#444',
    DARK_GRAY: '#444',
    MEDIUM_GRAY: '#666',
    LIGHT_GRAY: '#aaa',
    TEXT_WHITE: '#fff',
    TEXT_LIGHT: '#ddd',
    TEXT_MEDIUM: '#999',
    PROGRESS_GREEN: '#6c9',
    SHADOW: 'rgba(0,0,0,0.5)'
};

export const STYLES = {
    heading: {
        fontWeight: '600',
        color: COLORS.TEXT_WHITE,
        fontSize: '15px',
        marginBottom: '8px',
        wordBreak: 'break-word',
        lineHeight: '1.4',
        letterSpacing: '0.2px'
    },
    subheading: {
        fontSize: '13px',
        color: COLORS.LIGHT_GRAY,
        marginBottom: '12px',
        wordBreak: 'break-word',
        lineHeight: '1.5'
    },
    button: {
        padding: '8px 16px',
        border: 'none',
        borderRadius: '4px',
        cursor: 'pointer',
        fontSize: '14px',
        fontWeight: '500',
        transition: 'all 0.2s ease',
        display: 'flex',
        alignItems: 'center',
        gap: '6px'
    }
};

export const SCAN_PROGRESS = {
    NODES_WEIGHT: 33,
    METADATA_WEIGHT: 33,
    URL_RESOLUTION_WEIGHT: 34,
    POLL_INTERVAL: 500,
    DOWNLOAD_DELAY: 1000
};

export const STATUS_TYPES = {
    INFO: 'info',
    SUCCESS: 'success',
    WARNING: 'warning',
    ERROR: 'error'
};

export const STATUS_COLORS = {
    [STATUS_TYPES.INFO]: COLORS.PROGRESS_GREEN,
    [STATUS_TYPES.SUCCESS]: COLORS.PROGRESS_GREEN,
    [STATUS_TYPES.WARNING]: COLORS.WARNING_ORANGE,
    [STATUS_TYPES.ERROR]: COLORS.ERROR_RED
};

export const DIALOG_DIMENSIONS = {
    WIDTH: '900px',
    MAX_HEIGHT: '80vh',
    HEADER_FOOTER_HEIGHT: 250
};
