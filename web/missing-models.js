import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { $el, ComfyDialog } from "../../scripts/ui.js";
import { ComfyButton } from "../../scripts/ui/components/button.js";
import { ComfyButtonGroup } from "../../scripts/ui/components/buttonGroup.js";

// Color constants
const COLORS = {
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

// Common style objects
const STYLES = {
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

// Scan progress configuration
const SCAN_PROGRESS = {
    NODES_WEIGHT: 33,           // Progress percentage for node scanning
    METADATA_WEIGHT: 33,        // Progress percentage for metadata checking
    URL_RESOLUTION_WEIGHT: 34,  // Progress percentage for URL resolution
    POLL_INTERVAL: 500,         // Polling interval in milliseconds
    DOWNLOAD_DELAY: 1000        // Delay before starting downloads
};

// Status type constants
const STATUS_TYPES = {
    INFO: 'info',
    SUCCESS: 'success',
    WARNING: 'warning',
    ERROR: 'error'
};

// Status color mapping
const STATUS_COLORS = {
    [STATUS_TYPES.INFO]: COLORS.PROGRESS_GREEN,
    [STATUS_TYPES.SUCCESS]: COLORS.PROGRESS_GREEN,
    [STATUS_TYPES.WARNING]: COLORS.WARNING_ORANGE,
    [STATUS_TYPES.ERROR]: COLORS.ERROR_RED
};

// Dialog dimensions
const DIALOG_DIMENSIONS = {
    WIDTH: '900px',
    MAX_HEIGHT: '80vh',
    HEADER_FOOTER_HEIGHT: 250
};

/**
 * Create a styled button with hover effects
 * @param {string} text - Button text
 * @param {object} options - Button configuration
 * @param {string} options.color - Base background color
 * @param {string} options.hoverColor - Hover state color
 * @param {string} options.activeColor - Active state color
 * @param {function} options.onClick - Click handler
 * @param {object} options.extraStyles - Additional styles to merge
 * @returns {HTMLElement} Button element
 */
function createStyledButton(text, options = {}) {
    const {
        color,
        hoverColor,
        activeColor,
        onClick,
        extraStyles = {}
    } = options;

    const button = $el("button", {
        textContent: text,
        style: {
            ...STYLES.button,
            backgroundColor: color,
            color: COLORS.TEXT_WHITE,
            ...extraStyles
        }
    });

    // Mouse event handlers for hover effects
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

/**
 * Poll an endpoint repeatedly until a stop condition is met
 * @param {string} url - Endpoint URL to poll
 * @param {function} onUpdate - Callback with response data: (data) => void
 * @param {function} shouldStop - Function to check if polling should stop: (data) => boolean
 * @param {number} interval - Polling interval in milliseconds (default: 100)
 * @param {function} onError - Optional error handler: (error) => void
 * @returns {function} Stop function to manually cancel polling
 */
function pollEndpoint(url, onUpdate, shouldStop, interval = 100, onError = null) {
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

    // Return stop function
    return () => clearInterval(pollInterval);
}

/**
 * Create a model card with consistent structure
 * @param {object} config - Card configuration
 * @param {string} config.model - Model data
 * @param {string} config.type - Card type: 'downloadable', 'not_found', 'corrected'
 * @param {object} config.styling - Custom styling overrides
 * @param {array} config.infoItems - Additional info items to display
 * @param {HTMLElement} config.actionElement - Action button or indicator
 * @param {array} config.extraElements - Additional elements to append
 * @returns {HTMLElement} Card element
 */
function createModelCardBase(config) {
    const {
        model,
        type = 'downloadable',
        styling = {},
        infoItems = [],
        actionElement = null,
        extraElements = []
    } = config;

    // Type-specific default styling
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

    // Build info section
    const infoSection = $el("div", {
        style: { flex: '1', marginRight: '15px' }
    }, [
        // Model name
        $el("div", {
            textContent: model.name,
            style: {
                ...STYLES.heading,
                fontSize: type === 'corrected' ? '14px' : '15px',
                marginBottom: type === 'corrected' ? '6px' : '8px'
            }
        }),
        // Info items
        ...infoItems
    ]);

    // Main content structure
    const contentChildren = type === 'corrected' ?
        [
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
        ] :
        [
            infoSection,
            actionElement
        ].filter(el => el !== null);

    const mainContent = $el("div", {
        style: {
            display: 'flex',
            justifyContent: type === 'corrected' ? 'flex-start' : 'space-between',
            alignItems: 'flex-start'
        }
    }, contentChildren);

    const card = $el(`div.${type === 'corrected' ? 'corrected-' : ''}model-card`, {
        style: cardStyle
    }, [mainContent, ...extraElements].filter(el => el !== null));

    return card;
}

/**
 * Dialog for displaying and downloading missing models
 */
class MissingModelsDialog extends ComfyDialog {
    constructor() {
        super();
        this.missingModels = [];
        this.notFoundModels = [];
        this.correctedModels = [];
        this.downloadingModels = new Set();
        this.progressInterval = null;
        this.availableFolders = [];

        this.element = $el("div.comfy-modal", {
            id: 'missing-models-dialog',
            parent: document.body,
            style: {
                width: DIALOG_DIMENSIONS.WIDTH,
                maxHeight: DIALOG_DIMENSIONS.MAX_HEIGHT,
                overflow: 'hidden',
                display: 'none',
                zIndex: 1000,
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                opacity: '0',
                transition: 'opacity 0.3s ease-in-out'
            }
        }, [
            this.createContent()
        ]);
    }

    createContent() {
        this.titleElement = $el("div.cm-title", {
            style: {
                padding: '16px 20px',
                backgroundColor: '#1a1a1a',
                borderBottom: '2px solid #444',
                textAlign: 'center',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                boxSizing: 'border-box',
                flexShrink: '0'
            }
        }, [
            $el("h2", {
                textContent: "Download Missing Models",
                style: {
                    margin: '0',
                    color: '#fff',
                    fontSize: '18px',
                    fontWeight: '600',
                    letterSpacing: '0.3px',
                    lineHeight: '1.2'
                }
            })
        ]);

        this.statusElement = $el("div.status-bar", {
            style: {
                padding: '12px 20px',
                backgroundColor: '#252525',
                borderBottom: '1px solid #444',
                color: '#aaa',
                fontSize: '14px',
                lineHeight: '1.5',
                fontWeight: '400'
            }
        }, [
            $el("span", { textContent: "Scanning workflow for missing models..." })
        ]);

        this.modelsListElement = $el("div.models-list", {
            style: {
                padding: '16px 20px',
                maxHeight: `calc(${DIALOG_DIMENSIONS.MAX_HEIGHT} - ${DIALOG_DIMENSIONS.HEADER_FOOTER_HEIGHT}px)`,
                overflowY: 'auto',
                backgroundColor: '#2a2a2a'
            }
        }, [
            $el("div", {
                textContent: "No models scanned yet",
                style: {
                    textAlign: 'center',
                    color: '#666',
                    padding: '40px',
                    fontSize: '14px',
                    lineHeight: '1.5'
                }
            })
        ]);

        this.downloadAllButton = createStyledButton("Download All", {
            color: COLORS.PRIMARY_GREEN,
            hoverColor: COLORS.PRIMARY_GREEN_HOVER,
            activeColor: COLORS.PRIMARY_GREEN_ACTIVE,
            onClick: () => this.downloadAllModels(),
            extraStyles: {
                padding: '10px 24px',
                boxShadow: '0 2px 4px rgba(40, 167, 69, 0.3)'
            }
        });
        this.downloadAllButton.className = "comfyui-button";

        this.buttonsElement = $el("div.button-bar", {
            style: {
                padding: '15px',
                backgroundColor: '#1a1a1a',
                borderTop: '1px solid #444',
                display: 'flex',
                gap: '12px',
                justifyContent: 'center'
            }
        }, [
            this.downloadAllButton,
            (() => {
                const closeButton = createStyledButton("Close", {
                    color: COLORS.MEDIUM_GRAY,
                    hoverColor: '#555',
                    activeColor: '#444',
                    onClick: () => this.close(),
                    extraStyles: {
                        padding: '10px 24px',
                        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)'
                    }
                });
                closeButton.className = "comfyui-button";
                return closeButton;
            })()
        ]);

        return $el("div.comfy-modal-content", {
            style: {
                backgroundColor: '#2a2a2a',
                borderRadius: '8px',
                overflow: 'hidden',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
                border: '1px solid #444',
                display: 'flex',
                flexDirection: 'column'
            }
        }, [
            this.titleElement,
            this.statusElement,
            this.modelsListElement,
            this.buttonsElement
        ]);
    }

    async loadAvailableFolders() {
        try {
            const response = await api.fetchApi('/download-missing/folders');
            if (response.ok) {
                const result = await response.json();
                if (result.status === 'success') {
                    this.availableFolders = result.folders || [];
                    console.log(`[Missing Models] Loaded ${this.availableFolders.length} available folders`);
                }
            }
        } catch (error) {
            console.error("[Missing Models] Error loading folders:", error);
            // Continue even if folder loading fails
        }
    }

    async scanWorkflow() {
        try {
            // Show progress bar
            this.showScanProgress();

            // Start polling for scan progress
            const stopPolling = pollEndpoint(
                '/download-missing/scan-progress',
                (data) => {
                    if (data.status === 'success' && data.progress?.current) {
                        this.updateScanProgress(data.progress.current);
                    }
                },
                () => false, // Never stop on its own - we'll stop it manually
                100,
                (err) => console.error("[Missing Models] Progress poll error:", err)
            );

            // Get current workflow
            const workflow = app.graph.serialize();

            // Call backend API
            const response = await api.fetchApi('/download-missing/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflow })
            });

            // Stop polling
            stopPolling();

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();

            if (result.status === 'success') {
                this.missingModels = result.missing_models || [];
                this.notFoundModels = result.not_found_models || [];
                this.correctedModels = result.corrected_models || [];

                // Apply corrections to the actual ComfyUI graph
                if (this.correctedModels.length > 0) {
                    this.applyCorrectionsToGraph(this.correctedModels);
                }

                this.displayModels();

                // Build status message
                const messages = [];
                if (this.correctedModels.length > 0) {
                    messages.push(`${this.correctedModels.length} model(s) found and corrected`);
                }
                if (this.missingModels.length > 0) {
                    messages.push(`${this.missingModels.length} model(s) ready to download`);
                }
                if (this.notFoundModels.length > 0) {
                    messages.push(`${this.notFoundModels.length} model(s) not found`);
                }

                if (messages.length === 0) {
                    this.updateStatus("No missing models found! All models are installed.", STATUS_TYPES.SUCCESS);
                } else {
                    const statusMessage = messages.join(', ') + '.';
                    const hasIssues = this.missingModels.length > 0 || this.notFoundModels.length > 0;
                    this.updateStatus(statusMessage, hasIssues ? STATUS_TYPES.WARNING : STATUS_TYPES.SUCCESS);
                }
            } else {
                throw new Error(result.message || "Unknown error");
            }
        } catch (error) {
            console.error("[Missing Models] Scan error:", error);
            this.updateStatus(`Error scanning workflow: ${error.message}`, STATUS_TYPES.ERROR);
        }
    }


    applyCorrectionsToGraph(corrections) {
        try {
            let appliedCount = 0;
            console.log(`[Missing Models] Applying ${corrections.length} corrections to graph...`);

            for (const correction of corrections) {
                // Find the node in the graph
                const node = app.graph.getNodeById(correction.node_id);

                if (!node) {
                    console.warn(`[Missing Models] Node ${correction.node_id} not found in graph`);
                    continue;
                }

                console.log(`[Missing Models] Processing ${correction.correction_type} correction for node ${correction.node_id} (${node.type})`);

                if (correction.correction_type === 'widget') {
                    // Handle widget corrections
                    if (correction.widget_index === undefined) {
                        console.warn(`[Missing Models] Widget correction missing widget_index`);
                        continue;
                    }

                    // Update widgets_values array
                    if (node.widgets_values && node.widgets_values[correction.widget_index] !== undefined) {
                        const oldValue = node.widgets_values[correction.widget_index];
                        node.widgets_values[correction.widget_index] = correction.new_path;
                        console.log(`[Missing Models] ✓ Updated widgets_values[${correction.widget_index}]: "${oldValue}" -> "${correction.new_path}"`);
                        appliedCount++;
                    }

                    // Also update the widget object if it exists
                    if (node.widgets && node.widgets[correction.widget_index]) {
                        node.widgets[correction.widget_index].value = correction.new_path;
                        console.log(`[Missing Models] ✓ Updated widget object value`);
                    }

                } else if (correction.correction_type === 'property') {
                    // Handle property corrections
                    if (correction.property_index === undefined) {
                        console.warn(`[Missing Models] Property correction missing property_index`);
                        continue;
                    }

                    // Update properties.models array
                    if (node.properties && node.properties.models && node.properties.models[correction.property_index]) {
                        const oldValue = node.properties.models[correction.property_index].name;
                        node.properties.models[correction.property_index].name = correction.new_path;
                        console.log(`[Missing Models] ✓ Updated properties.models[${correction.property_index}].name: "${oldValue}" -> "${correction.new_path}"`);
                        appliedCount++;
                    }
                }
            }

            // Force graph update and persistence
            if (appliedCount > 0) {
                app.graph.setDirtyCanvas(true, true);
                app.graph.change();
                console.log(`[Missing Models] ✓ Applied ${appliedCount} path corrections to workflow`);
                console.log(`[Missing Models] ✓ Graph marked as modified and changes persisted`);
            } else {
                console.warn(`[Missing Models] No corrections were applied (0/${corrections.length})`);
            }
        } catch (error) {
            console.error("[Missing Models] Error applying corrections:", error);
        }
    }

    updateDownloadAllButtonState() {
        // Debounce to prevent state thrashing during rapid updates
        if (this._updateButtonTimeout) {
            clearTimeout(this._updateButtonTimeout);
        }

        this._updateButtonTimeout = setTimeout(() => {
            this._updateDownloadAllButtonStateImmediate();
        }, 100);
    }

    _updateDownloadAllButtonStateImmediate() {
        // Check if there are any models ready to download (have URLs and not already completed)
        const modelsReadyToDownload = this.missingModels.filter(m => {
            const hasUrl = m.url && m.url.trim() !== '';
            const notDownloading = !this.downloadingModels.has(m.name);
            const notCompleted = !m._downloadButton || m._downloadButton.textContent !== "Completed";
            return hasUrl && (notDownloading || notCompleted);
        });

        const hasModelsToDownload = modelsReadyToDownload.length > 0;

        if (this.downloadAllButton) {
            this.downloadAllButton.disabled = !hasModelsToDownload;
            if (hasModelsToDownload) {
                this.downloadAllButton.style.backgroundColor = COLORS.PRIMARY_GREEN;
                this.downloadAllButton.style.cursor = 'pointer';
                this.downloadAllButton.style.opacity = '1';
            } else {
                this.downloadAllButton.style.backgroundColor = COLORS.DARK_GRAY;
                this.downloadAllButton.style.cursor = 'not-allowed';
                this.downloadAllButton.style.opacity = '0.5';
            }
        }
    }

    showScanProgress() {
        // Clear existing content
        this.modelsListElement.innerHTML = '';

        // Create scan progress container
        const progressContainer = $el("div", {
            style: {
                padding: '40px',
                textAlign: 'center'
            }
        }, [
            $el("div", {
                textContent: "Scanning workflow...",
                style: {
                    fontSize: '16px',
                    color: '#ddd',
                    marginBottom: '20px'
                }
            }),
            $el("div.progress-bar", {
                style: {
                    width: '100%',
                    height: '8px',
                    backgroundColor: '#333',
                    borderRadius: '4px',
                    overflow: 'hidden',
                    position: 'relative'
                }
            }, [
                $el("div.progress-fill", {
                    style: {
                        width: '0%',
                        height: '100%',
                        backgroundColor: '#6c9',
                        transition: 'width 0.3s ease',
                        borderRadius: '4px'
                    }
                })
            ]),
            $el("div", {
                textContent: "Scanning workflow nodes...",
                style: {
                    fontSize: '13px',
                    color: '#999',
                    marginTop: '12px'
                }
            })
        ]);

        this._scanProgressContainer = progressContainer;
        this._scanProgressFill = progressContainer.querySelector('.progress-fill');
        this._scanProgressMessage = progressContainer.children[2];

        this.modelsListElement.appendChild(progressContainer);
    }

    updateScanProgress(progress) {
        if (this._scanProgressFill) {
            this._scanProgressFill.style.width = `${progress.progress}%`;
        }
        if (this._scanProgressMessage) {
            this._scanProgressMessage.textContent = progress.message || 'Scanning...';
        }
    }

    displayModels() {
        this.modelsListElement.innerHTML = '';

        const hasAnyModels = this.missingModels.length > 0 ||
                            this.notFoundModels.length > 0 ||
                            this.correctedModels.length > 0;

        if (!hasAnyModels) {
            this.modelsListElement.appendChild(
                $el("div", {
                    textContent: "No missing models found",
                    style: {
                        textAlign: 'center',
                        color: '#666',
                        padding: '40px',
                        fontSize: '14px',
                        lineHeight: '1.5'
                    }
                })
            );
            this.updateDownloadAllButtonState();
            return;
        }

        // Display corrected models first if any
        if (this.correctedModels.length > 0) {
            this.modelsListElement.appendChild(this.createCorrectedModelsSection());
        }

        // Display missing models with URLs (ready to download)
        if (this.missingModels.length > 0) {
            if (this.correctedModels.length > 0) {
                this.modelsListElement.appendChild($el("div", {
                    style: { height: '1px', backgroundColor: '#444', margin: '20px 0' }
                }));
            }

            this.modelsListElement.appendChild($el("h3", {
                textContent: "Missing Models - Ready to Download",
                style: {
                    color: '#fff',
                    fontSize: '16px',
                    fontWeight: '600',
                    marginBottom: '12px',
                    marginTop: '0'
                }
            }));

            this.missingModels.forEach((model, index) => {
                const modelCard = this.createModelCard(model, index);
                this.modelsListElement.appendChild(modelCard);
            });
        }

        // Display models that couldn't be found
        if (this.notFoundModels.length > 0) {
            if (this.correctedModels.length > 0 || this.missingModels.length > 0) {
                this.modelsListElement.appendChild($el("div", {
                    style: { height: '1px', backgroundColor: '#444', margin: '20px 0' }
                }));
            }

            this.modelsListElement.appendChild($el("h3", {
                textContent: "Models Not Found",
                style: {
                    color: '#f66',
                    fontSize: '16px',
                    fontWeight: '600',
                    marginBottom: '12px',
                    marginTop: '0'
                }
            }));

            this.notFoundModels.forEach((model) => {
                const modelCard = this.createNotFoundModelCard(model);
                this.modelsListElement.appendChild(modelCard);
            });
        }

        // Update Download All button state after displaying models
        this.updateDownloadAllButtonState();
    }

    createNotFoundModelCard(model) {
        const infoItems = [
            $el("div", {
                textContent: `Directory: ${model.directory || model.folder}`,
                style: {
                    fontSize: '12px',
                    color: COLORS.MEDIUM_GRAY,
                    marginBottom: '6px',
                    lineHeight: '1.5',
                    fontWeight: '400'
                }
            }),
            $el("div", {
                textContent: "Not found in workflow notes or popular repositories",
                style: {
                    fontSize: '11px',
                    color: '#f66',
                    fontStyle: 'italic',
                    lineHeight: '1.5',
                    fontWeight: '400'
                }
            })
        ];

        const actionElement = (() => {
            const btn = createStyledButton("Not Found", {
                color: COLORS.MEDIUM_GRAY,
                hoverColor: COLORS.MEDIUM_GRAY,
                activeColor: COLORS.MEDIUM_GRAY,
                extraStyles: {
                    padding: '8px 18px',
                    fontSize: '13px',
                    cursor: 'not-allowed',
                    opacity: '0.6'
                }
            });
            btn.disabled = true;
            btn.className = "comfyui-button";
            return btn;
        })();

        return createModelCardBase({
            model,
            type: 'not_found',
            infoItems,
            actionElement
        });
    }

    createCorrectedModelsSection() {
        const section = $el("div.corrected-models-section", {
            style: {
                marginBottom: '20px'
            }
        }, [
            $el("h3", {
                textContent: "✓ Found & Corrected Models",
                style: {
                    color: '#28a745',
                    fontSize: '16px',
                    fontWeight: '600',
                    marginBottom: '12px',
                    marginTop: '0'
                }
            }),
            ...this.correctedModels.map(model => this.createCorrectedModelCard(model))
        ]);

        return section;
    }

    createCorrectedModelCard(model) {
        // Build node info text
        let nodeInfo = '';
        if (model.node_id !== null && model.node_id !== undefined) {
            nodeInfo = `Node #${model.node_id}`;
            if (model.node_type && model.node_type !== 'metadata') {
                nodeInfo += ` (${model.node_type})`;
            }
        } else if (model.node_type === 'metadata') {
            nodeInfo = 'Workflow metadata';
        }

        const infoItems = [
            // Old → New path display
            $el("div", {
                style: {
                    fontSize: '11px',
                    color: COLORS.LIGHT_GRAY,
                    marginBottom: '4px',
                    lineHeight: '1.5',
                    fontFamily: 'monospace'
                }
            }, [
                $el("span", {
                    textContent: `${model.old_path}`,
                    style: {
                        color: '#c88',
                        textDecoration: 'line-through'
                    }
                }),
                $el("span", {
                    textContent: " → ",
                    style: {
                        color: COLORS.MEDIUM_GRAY,
                        margin: '0 4px'
                    }
                }),
                $el("span", {
                    textContent: `${model.new_path}`,
                    style: {
                        color: '#8c8'
                    }
                })
            ]),
            // Directory
            $el("div", {
                textContent: `Directory: ${model.directory || model.folder}`,
                style: {
                    fontSize: '11px',
                    color: COLORS.MEDIUM_GRAY,
                    lineHeight: '1.5',
                    marginBottom: nodeInfo ? '4px' : '0'
                }
            }),
            // Node info (if available)
            nodeInfo ? $el("div", {
                textContent: nodeInfo,
                style: {
                    fontSize: '11px',
                    color: '#6a6',
                    lineHeight: '1.5',
                    fontWeight: '500'
                }
            }) : null
        ].filter(el => el !== null);

        return createModelCardBase({
            model,
            type: 'corrected',
            styling: {
                padding: '14px 16px',
                marginBottom: '10px'
            },
            infoItems
        });
    }

    createModelCard(model, index) {
        const hasUrl = model.url && model.url.trim() !== '';

        const progressBar = $el("div.progress-bar", {
            style: {
                width: '100%',
                height: '6px',
                backgroundColor: COLORS.DARK_GRAY,
                borderRadius: '3px',
                marginTop: '8px',
                overflow: 'hidden',
                display: 'none',
                boxShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.3)'
            }
        }, [
            $el("div.progress-fill", {
                style: {
                    width: '0%',
                    height: '100%',
                    background: `linear-gradient(90deg, ${COLORS.PRIMARY_BLUE} 0%, #00A0E3 100%)`,
                    transition: 'width 0.3s ease',
                    boxShadow: '0 0 10px rgba(0, 102, 204, 0.5)',
                    animation: 'none'
                }
            })
        ]);

        const statusText = $el("div.status-text", {
            style: {
                fontSize: '12px',
                color: COLORS.LIGHT_GRAY,
                marginTop: '6px',
                display: 'none',
                lineHeight: '1.5',
                fontWeight: '400'
            }
        });

        const needsFolderSelection = model.needs_folder_selection === true;
        const canDownload = hasUrl && !needsFolderSelection;

        const downloadButton = createStyledButton(hasUrl ? "Download" : "No URL", {
            color: canDownload ? COLORS.PRIMARY_BLUE : COLORS.DARK_GRAY,
            hoverColor: COLORS.PRIMARY_BLUE_HOVER,
            activeColor: COLORS.PRIMARY_BLUE_ACTIVE,
            onClick: async () => {
                if (hasUrl) {
                    await this.downloadModel(model, progressBar, statusText, downloadButton);
                }
            },
            extraStyles: {
                padding: '8px 18px',
                fontSize: '13px',
                cursor: canDownload ? 'pointer' : 'not-allowed',
                boxShadow: canDownload ? '0 2px 4px rgba(0, 102, 204, 0.3)' : 'none',
                opacity: canDownload ? '1' : '0.6'
            }
        });
        downloadButton.disabled = !canDownload;

        const card = $el("div.model-card", {
            style: {
                backgroundColor: '#333',
                padding: '16px',
                marginBottom: '12px',
                borderRadius: '6px',
                border: '1px solid #444',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)'
            }
        }, [
            $el("div", {
                style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start'
                }
            }, [
                $el("div", {
                    style: { flex: '1', marginRight: '15px' }
                }, [
                    $el("div", {
                        textContent: model.name,
                        style: {
                            fontWeight: '600',
                            color: '#fff',
                            fontSize: '15px',
                            marginBottom: '8px',
                            wordBreak: 'break-word',
                            lineHeight: '1.4',
                            letterSpacing: '0.2px'
                        }
                    }),
                    $el("div", {
                        textContent: `Directory: ${model.directory || model.folder}`,
                        style: {
                            fontSize: '12px',
                            color: COLORS.MEDIUM_GRAY,
                            marginBottom: '6px',
                            lineHeight: '1.5',
                            fontWeight: '400'
                        }
                    }),
                    hasUrl ? $el("div", {
                        textContent: `URL: ${this.truncateUrl(model.url)}`,
                        title: model.url,
                        style: {
                            fontSize: '11px',
                            color: COLORS.MEDIUM_GRAY,
                            fontFamily: 'monospace',
                            lineHeight: '1.5',
                            fontWeight: '400'
                        }
                    }) : $el("div", {
                        textContent: "URL: Not available - manual download required",
                        style: {
                            fontSize: '11px',
                            color: '#c44',
                            fontStyle: 'italic',
                            lineHeight: '1.5',
                            fontWeight: '400'
                        }
                    }),
                    // Folder selector for models needing manual selection
                    needsFolderSelection ? $el("div", {
                        style: {
                            marginTop: '10px',
                            marginBottom: '8px',
                            padding: '10px',
                            backgroundColor: '#2a2a2a',
                            borderRadius: '4px',
                            border: '1px solid #fa4'
                        }
                    }, [
                        $el("label", {
                            textContent: "⚠️ Select installation folder:",
                            style: {
                                fontSize: '12px',
                                color: '#fa4',
                                display: 'block',
                                marginBottom: '6px',
                                fontWeight: '600'
                            }
                        }),
                        $el("select", {
                            style: {
                                width: '100%',
                                padding: '8px',
                                backgroundColor: '#444',
                                color: '#fff',
                                border: '1px solid #666',
                                borderRadius: '4px',
                                fontSize: '13px',
                                cursor: 'pointer'
                            },
                            onchange: (e) => {
                                const selectedFolder = e.target.value;
                                if (selectedFolder) {
                                    model.folder = selectedFolder;
                                    model.directory = selectedFolder;
                                    model.needs_folder_selection = false;

                                    // Re-enable download button
                                    downloadButton.disabled = false;
                                    downloadButton.style.backgroundColor = COLORS.PRIMARY_BLUE;
                                    downloadButton.style.opacity = '1';
                                    downloadButton.style.cursor = 'pointer';

                                    console.log(`[Missing Models] Selected folder '${selectedFolder}' for ${model.name}`);
                                }
                            }
                        }, [
                            $el("option", {
                                value: "",
                                textContent: "-- Select destination folder --",
                                disabled: true,
                                selected: true
                            }),
                            ...this.availableFolders.map(folder =>
                                $el("option", {
                                    value: folder,
                                    textContent: folder
                                })
                            )
                        ])
                    ]) : null,
                    progressBar,
                    statusText
                ].filter(el => el !== null)),
                downloadButton
            ])
        ]);

        // Store references for later updates
        model._progressBar = progressBar;
        model._statusText = statusText;
        model._downloadButton = downloadButton;
        model._card = card;

        return card;
    }


    truncateUrl(url, maxLength = 60) {
        if (url.length <= maxLength) return url;
        return url.substring(0, maxLength - 3) + '...';
    }

    async downloadModel(model, progressBar, statusText, downloadButton) {
        // Prevent double-triggering - check and lock state immediately
        if (this.downloadingModels.has(model.name)) {
            return; // Already downloading
        }

        try {
            // Lock state immediately before any async operations
            this.downloadingModels.add(model.name);
            downloadButton.disabled = true;

            // Update UI
            downloadButton.textContent = "Downloading...";
            progressBar.style.display = 'block';
            statusText.style.display = 'block';
            statusText.textContent = 'Starting download...';
            statusText.style.color = '#aaa';

            // Start download
            const response = await api.fetchApi('/download-missing/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model_name: model.name,
                    model_url: model.url,
                    model_folder: model.folder,
                    expected_filename: model.expected_filename || model.name,  // What workflow needs
                    actual_filename: model.actual_filename || model.name,  // What HuggingFace has
                    node_id: model.node_id,
                    node_type: model.node_type,
                    correction_type: model.correction_type,
                    widget_index: model.widget_index,
                    property_index: model.property_index
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Parse response and apply correction if provided
            const result = await response.json();
            if (result.correction) {
                this.applyCorrectionsToGraph([result.correction]);
            }

            // Start polling for progress
            this.pollProgress(model);

        } catch (error) {
            console.error("[Missing Models] Download error:", error);
            this.downloadingModels.delete(model.name);

            statusText.textContent = `Error: ${error.message}`;
            statusText.style.color = '#f44';
            statusText.style.display = 'block';
            downloadButton.textContent = "Retry";
            downloadButton.disabled = false;
        }
    }

    async pollProgress(model) {
        const pollKey = model.expected_filename || model.name;
        const progressFill = model._progressBar.querySelector('.progress-fill');

        pollEndpoint(
            `/download-missing/status/${encodeURIComponent(pollKey)}`,
            (data) => {
                if (data.status === 'success' && data.progress) {
                    const progress = data.progress;

                    // Use requestAnimationFrame to sync DOM updates with browser paint cycle
                    requestAnimationFrame(() => {
                        // Update progress bar
                        if (progressFill) {
                            progressFill.style.width = `${progress.progress}%`;
                        }

                        // Update status text
                        if (progress.status === 'downloading') {
                            const downloadedMB = (progress.downloaded / (1024 * 1024)).toFixed(2);
                            const totalMB = (progress.total / (1024 * 1024)).toFixed(2);
                            model._statusText.textContent = `Downloading: ${downloadedMB} MB / ${totalMB} MB (${progress.progress}%)`;
                            model._statusText.style.color = COLORS.PROGRESS_GREEN;
                            // Add pulsing animation
                            if (progressFill) {
                                progressFill.classList.add('progress-downloading');
                            }
                        } else if (progress.status === 'completed') {
                            this.downloadingModels.delete(model.name);

                            // Remove pulsing animation
                            if (progressFill) {
                                progressFill.classList.remove('progress-downloading');
                            }

                            model._statusText.textContent = 'Download completed!';
                            model._statusText.style.color = COLORS.PROGRESS_GREEN;
                            model._downloadButton.textContent = "Completed";
                            model._downloadButton.style.backgroundColor = COLORS.PRIMARY_GREEN;
                            model._card.style.opacity = '0.7';

                            // Update Download All button state
                            this.updateDownloadAllButtonState();
                        } else if (progress.status === 'error') {
                            this.downloadingModels.delete(model.name);

                            model._statusText.textContent = `Error: ${progress.error || 'Unknown error'}`;
                            model._statusText.style.color = COLORS.ERROR_RED;
                            model._downloadButton.textContent = "Retry";
                            model._downloadButton.disabled = false;

                            // Update Download All button state
                            this.updateDownloadAllButtonState();
                        } else if (progress.status === 'cancelled') {
                            this.downloadingModels.delete(model.name);

                            model._statusText.textContent = 'Download cancelled';
                            model._statusText.style.color = COLORS.WARNING_ORANGE;
                            model._downloadButton.textContent = "Download";
                            model._downloadButton.disabled = false;

                            // Update Download All button state
                            this.updateDownloadAllButtonState();
                        }
                    });
                }
            },
            (data) => {
                // Stop polling when download reaches terminal state
                return data.status === 'success' && data.progress &&
                       ['completed', 'error', 'cancelled'].includes(data.progress.status);
            },
            500, // Poll every 500ms
            (error) => console.error("[Missing Models] Poll error:", error)
        );
    }

    async downloadAllModels() {
        const modelsWithUrls = this.missingModels.filter(m => m.url && m.url.trim() !== '');

        if (modelsWithUrls.length === 0) {
            this.updateStatus("No models with URLs to download", STATUS_TYPES.WARNING);
            return;
        }

        this.updateStatus(`Starting ${modelsWithUrls.length} download(s)...`, STATUS_TYPES.INFO);

        // Start all downloads in parallel (filter before starting to avoid race conditions)
        const downloadPromises = modelsWithUrls
            .filter(m => m._downloadButton && !m._downloadButton.disabled)
            .map(model =>
                this.downloadModel(
                    model,
                    model._progressBar,
                    model._statusText,
                    model._downloadButton
                )
            );

        // Wait for all API calls to initiate (not for downloads to complete)
        await Promise.allSettled(downloadPromises);
    }

    updateStatus(message, type = STATUS_TYPES.INFO) {
        this.statusElement.innerHTML = '';
        this.statusElement.appendChild(
            $el("span", {
                textContent: message,
                style: {
                    color: STATUS_COLORS[type] || COLORS.LIGHT_GRAY
                }
            })
        );
    }

    async show() {
        // Reset state from previous run
        this.missingModels = [];
        this.notFoundModels = [];
        this.correctedModels = [];
        this.downloadingModels.clear();
        this.modelsListElement.innerHTML = '';
        this.updateStatus("Initializing...", STATUS_TYPES.INFO);

        // Show dialog immediately to display progress
        this.element.style.display = "block";
        setTimeout(() => {
            this.element.style.opacity = "1";
        }, 10);

        // Load available folders first
        await this.loadAvailableFolders();

        // Scan workflow and show progress
        await this.scanWorkflow();
    }

    close() {
        // Fade out animation
        this.element.style.opacity = "0";
        setTimeout(() => {
            this.element.style.display = "none";
        }, 300);

        // Stop all downloads
        this.downloadingModels.forEach(modelName => {
            api.fetchApi('/download-missing/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model_name: modelName })
            }).catch(err => console.error("Error cancelling download:", err));
        });
        this.downloadingModels.clear();
    }
}

// Global instances
let dialog = null;
let buttonGroup = null;

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
    @keyframes progressPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.8; }
    }

    .progress-downloading {
        animation: progressPulse 1.5s ease-in-out infinite;
    }
`;
document.head.appendChild(style);

// Add button to ComfyUI menu
function addDownloadMissingButton() {
    try {
        // Remove existing button group if it exists
        if (buttonGroup && buttonGroup.element?.parentElement) {
            buttonGroup.element.parentElement.removeChild(buttonGroup.element);
            buttonGroup = null;
        }

        // Create the button using ComfyButton
        const missingModelsButton = new ComfyButton({
            icon: "download",
            tooltip: "Download Missing Models",
            app,
            enabled: true,
            classList: "comfyui-button comfyui-menu-mobile-collapse",
            action: () => {
                if (!dialog) {
                    dialog = new MissingModelsDialog();
                }
                dialog.show();
            }
        });

        // Create button group
        buttonGroup = new ComfyButtonGroup(missingModelsButton);

        // Add to top bar - try to place it before the settings group
        if (app.menu?.settingsGroup?.element) {
            app.menu.settingsGroup.element.before(buttonGroup.element);
            console.log("[Missing Models] Button added to top bar before settings");
        } else {
            // Fallback: try to find the top bar and add it there
            const topBar = document.querySelector(".comfy-menu");
            if (topBar) {
                topBar.appendChild(buttonGroup.element);
                console.log("[Missing Models] Button added to menu bar (fallback)");
            }
        }

        console.log("[Missing Models] Button successfully added");
    } catch (error) {
        console.error("[Missing Models] Error adding button:", error);
    }
}

// Register extension
app.registerExtension({
    name: "ComfyUI.DownloadMissingModels",

    async init() {
        console.log("[Missing Models] Extension init called");
    },

    async setup() {
        console.log("[Missing Models] Extension setup called");
        // Add button after UI is ready
        setTimeout(() => {
            console.log("[Missing Models] Adding button...");
            addDownloadMissingButton();
        }, 1000);
    }
});

console.log("[Missing Models] Extension script loaded");
