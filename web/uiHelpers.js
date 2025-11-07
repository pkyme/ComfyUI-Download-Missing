import { STYLES, COLORS } from "./constants.js";
import { api } from "../../scripts/api.js";

export function createStyledButton(text, options = {}) {
    const {
        color,
        hoverColor,
        activeColor,
        onClick,
        extraStyles = {}
    } = options;

    const button = document.createElement("button");
    Object.assign(button, { textContent: text });
    Object.assign(button.style, {
        ...STYLES.button,
        backgroundColor: color,
        color: COLORS.TEXT_WHITE,
        ...extraStyles
    });

    button.addEventListener('mouseenter', (e) => {
        if (!e.currentTarget.disabled) {
            e.currentTarget.style.backgroundColor = hoverColor;
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = `0 4px 8px ${COLORS.SHADOW}`;
        }
    });

    button.addEventListener('mouseleave', (e) => {
        if (!e.currentTarget.disabled) {
            e.currentTarget.style.backgroundColor = color;
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = 'none';
        }
    });

    button.addEventListener('mousedown', (e) => {
        if (!e.currentTarget.disabled) {
            e.currentTarget.style.backgroundColor = activeColor;
            e.currentTarget.style.transform = 'translateY(0)';
        }
    });

    button.addEventListener('mouseup', (e) => {
        if (!e.currentTarget.disabled) {
            e.currentTarget.style.backgroundColor = hoverColor;
            e.currentTarget.style.transform = 'translateY(-1px)';
        }
    });

    if (onClick) {
        button.addEventListener('click', onClick);
    }

    return button;
}

export function pollEndpoint(url, onUpdate, shouldStop, interval = 100, onError = null) {
    const pollInterval = setInterval(async () => {
        try {
            const response = await api.fetchApi(url);
            if (!response.ok) {
                clearInterval(pollInterval);
                if (onError) {
                    onError(new Error(`HTTP ${response.status}`));
                }
                return;
            }

            const data = await response.json();
            onUpdate(data);

            if (shouldStop(data)) {
                clearInterval(pollInterval);
            }
        } catch (err) {
            if (onError) {
                onError(err);
            } else {
                console.error("[Polling Error]", err);
            }
        }
    }, interval);

    return () => clearInterval(pollInterval);
}
