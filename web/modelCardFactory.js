import { $el } from "../../scripts/ui.js";
import { COLORS, STYLES } from "./constants.js";

export function createModelCardBase(config) {
    const {
        model,
        type = 'downloadable',
        styling = {},
        infoItems = [],
        actionElement = null,
        extraElements = []
    } = config;

    const typeStyles = {
        downloadable: {
            backgroundColor: '#333',
            border: '1px solid #444',
            opacity: '1'
        },
        not_found: {
            backgroundColor: '#3a2a2a',
            border: '1px solid #844',
            opacity: '0.8'
        },
        corrected: {
            backgroundColor: '#1a3a1a',
            border: '1px solid #2d5a2d',
            boxShadow: '0 2px 6px rgba(40, 167, 69, 0.15)'
        }
    };

    const cardStyle = {
        padding: '16px',
        marginBottom: '12px',
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
        ...typeStyles[type],
        ...styling
    };

    const infoSection = $el("div", {
        style: { flex: '1', marginRight: '15px' }
    }, [
        $el("div", {
            textContent: model.name,
            style: {
                ...STYLES.heading,
                fontSize: type === 'corrected' ? '14px' : '15px',
                marginBottom: type === 'corrected' ? '6px' : '8px'
            }
        }),
        ...infoItems
    ]);

    const contentChildren = type === 'corrected'
        ? [
            $el("div", {
                textContent: "✓",
                style: {
                    color: COLORS.PRIMARY_GREEN,
                    fontSize: '18px',
                    fontWeight: 'bold',
                    marginRight: '12px',
                    lineHeight: '1.4'
                }
            }),
            $el("div", { style: { flex: '1' } }, [
                infoSection,
                ...extraElements
            ])
        ]
        : [
            infoSection,
            actionElement
        ].filter(Boolean);

    const mainContent = $el("div", {
        style: {
            display: 'flex',
            justifyContent: type === 'corrected' ? 'flex-start' : 'space-between',
            alignItems: 'flex-start'
        }
    }, contentChildren);

    return $el(`div.${type === 'corrected' ? 'corrected-' : ''}model-card`, {
        style: cardStyle
    }, [mainContent, ...extraElements].filter(Boolean));
}
