import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { $el, ComfyDialog } from "../../scripts/ui.js";
import { ComfyButton } from "../../scripts/ui/components/button.js";
import { ComfyButtonGroup } from "../../scripts/ui/components/buttonGroup.js";
import {
    COLORS,
    STYLES,
    SCAN_PROGRESS,
    STATUS_TYPES,
    STATUS_COLORS,
    DIALOG_DIMENSIONS
} from "./constants.js";
import { createStyledButton, pollEndpoint } from "./uiHelpers.js";
import { createModelCardBase } from "./modelCardFactory.js";

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
        this.pendingProgressUpdates = new Map();
        this.uiFrozen = false;
        this.isMouseDown = false;
        this.domUpdateQueue = [];
        this.progressInterval = null;
        this.availableFolders = [];

        // Scroll interaction tracking for preventing DOM updates during drag scrolling
        this.mouseDownHandler = null;
        this.mouseUpHandler = null;

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

        // Attach drag listeners to pause UI updates while scrollbar is held
        this.mouseDownHandler = () => {
            this.isMouseDown = true;
            this.freezeUI();
        };
        this.modelsListElement.addEventListener('mousedown', this.mouseDownHandler);
        this.mouseUpHandler = () => {
            this.isMouseDown = false;
            this.unfreezeUI();
        };
        document.addEventListener('mouseup', this.mouseUpHandler);

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

    freezeUI() {
        this.uiFrozen = true;
    }

    unfreezeUI() {
        if (this.isMouseDown) {
            return;
        }
        if (!this.uiFrozen) {
            return;
        }
        this.uiFrozen = false;
        this.flushPendingProgressUpdates();
        this.flushDomUpdateQueue();
    }

    scheduleDomUpdate(callback) {
        if (this.uiFrozen) {
            this.domUpdateQueue.push(callback);
        } else {
            callback();
        }
    }

    flushDomUpdateQueue() {
        if (this.uiFrozen || this.domUpdateQueue.length === 0) {
            return;
        }

        const updates = this.domUpdateQueue.splice(0, this.domUpdateQueue.length);
        for (const updateFn of updates) {
            try {
                updateFn();
            } catch (err) {
                console.error("[Missing Models] Deferred UI update failed:", err);
            }
        }
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
        this.scheduleDomUpdate(() => {
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
        });
    }

    showScanProgress() {
        this.scheduleDomUpdate(() => {
            this.modelsListElement.innerHTML = '';

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
        });
    }

    updateScanProgress(progress) {
        this.scheduleDomUpdate(() => {
            if (this._scanProgressFill) {
                this._scanProgressFill.style.width = `${progress.progress}%`;
            }
            if (this._scanProgressMessage) {
                this._scanProgressMessage.textContent = progress.message || 'Scanning...';
            }
        });
    }

    displayModels() {
        this.scheduleDomUpdate(() => {
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

            if (this.correctedModels.length > 0) {
                this.modelsListElement.appendChild(this.createCorrectedModelsSection());
            }

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

            this.updateDownloadAllButtonState();
        });
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
        const suggestions = Array.isArray(model.search_suggestions) ? model.search_suggestions : [];
        const hasSuggestionMatches = suggestions.length > 0 && model.has_exact_hf_match !== true;
        let hasUrl = Boolean(model.url && model.url.trim() !== '');

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

        let needsFolderSelection = model.needs_folder_selection === true;
        let canDownload = hasUrl && !needsFolderSelection;

        const downloadButton = createStyledButton(hasUrl ? "Download" : (hasSuggestionMatches ? "Select Match" : "No URL"), {
            color: canDownload ? COLORS.PRIMARY_BLUE : COLORS.DARK_GRAY,
            hoverColor: COLORS.PRIMARY_BLUE_HOVER,
            activeColor: COLORS.PRIMARY_BLUE_ACTIVE,
            onClick: async () => {
                if (model.url && model.url.trim() !== '') {
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

        const updateDownloadButtonState = () => {
            hasUrl = Boolean(model.url && model.url.trim() !== '');
            canDownload = hasUrl && !needsFolderSelection;
            downloadButton.disabled = !canDownload;
            downloadButton.textContent = hasUrl ? "Download" : (hasSuggestionMatches ? "Select Match" : "No URL");
            downloadButton.style.cursor = canDownload ? 'pointer' : 'not-allowed';
            downloadButton.style.backgroundColor = canDownload ? COLORS.PRIMARY_BLUE : COLORS.DARK_GRAY;
            downloadButton.style.opacity = canDownload ? '1' : '0.6';
        };
        updateDownloadButtonState();

        const card = $el("div.model-card", {
            style: {
                backgroundColor: hasSuggestionMatches ? COLORS.SUGGESTION_BG : '#333',
                padding: '16px',
                marginBottom: '12px',
                borderRadius: '6px',
                border: hasSuggestionMatches ? `1px solid ${COLORS.SUGGESTION_BORDER}` : '1px solid #444',
                boxShadow: hasSuggestionMatches ? '0 2px 8px rgba(124, 93, 255, 0.3)' : '0 2px 8px rgba(0, 0, 0, 0.3)'
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
                    hasSuggestionMatches ? $el("div", {
                        textContent: "No exact HuggingFace match. Choose one of the suggested files below.",
                        style: {
                            fontSize: '12px',
                            color: COLORS.SUGGESTION_ACCENT,
                            marginBottom: '6px',
                            lineHeight: '1.5',
                            fontWeight: '500'
                        }
                    }) : null,
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
                    (() => {
                        const urlDisplay = $el("div", {
                            style: {
                                fontSize: '11px',
                                fontFamily: 'monospace',
                                lineHeight: '1.5',
                                fontWeight: '400'
                            }
                        });
                        model._urlDisplay = urlDisplay;
                        this.updateUrlDisplay(model, urlDisplay, hasSuggestionMatches);
                        return urlDisplay;
                    })(),
                    hasSuggestionMatches ? this.createSuggestionSelector({
                        model,
                        suggestions,
                        onChange: () => {
                            this.updateUrlDisplay(model, model._urlDisplay, hasSuggestionMatches);
                            updateDownloadButtonState();
                            this.updateDownloadAllButtonState();
                        }
                    }) : null,
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
                                    needsFolderSelection = false;
                                    updateDownloadButtonState();
                                    this.updateDownloadAllButtonState();
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
        if (!url) return '';
        if (url.length <= maxLength) return url;
        const half = Math.floor((maxLength - 3) / 2);
        return `${url.slice(0, half)}...${url.slice(-half)}`;
    }

    updateUrlDisplay(model, element, hasSuggestions = false) {
        if (!element) {
            return;
        }

        if (model.url && model.url.trim() !== '') {
            element.textContent = `URL: ${this.truncateUrl(model.url)}`;
            element.title = model.url;
            element.style.color = COLORS.MEDIUM_GRAY;
            element.style.fontStyle = 'normal';
        } else if (hasSuggestions) {
            element.textContent = 'URL: Select a suggested match to enable download';
            element.title = '';
            element.style.color = COLORS.SUGGESTION_ACCENT;
            element.style.fontStyle = 'italic';
        } else {
            element.textContent = 'URL: Not available - manual download required';
            element.title = '';
            element.style.color = '#c44';
            element.style.fontStyle = 'italic';
        }
    }

    createSuggestionSelector({ model, suggestions, onChange }) {
        const container = $el("div", {
            style: {
                marginTop: '10px',
                marginBottom: '6px',
                padding: '10px',
                backgroundColor: '#272033',
                borderRadius: '4px',
                border: `1px solid ${COLORS.SUGGESTION_BORDER}`
            }
        });

        const label = $el("label", {
            textContent: "Top matches (closest first):",
            style: {
                fontSize: '12px',
                color: COLORS.SUGGESTION_ACCENT,
                display: 'block',
                marginBottom: '6px',
                fontWeight: '600'
            }
        });

        const select = $el("select", {
            style: {
                width: '100%',
                padding: '8px',
                backgroundColor: '#3a3450',
                color: '#fff',
                border: `1px solid ${COLORS.SUGGESTION_BORDER}`,
                borderRadius: '4px',
                fontSize: '13px',
                cursor: 'pointer'
            }
        });

        const formatLabel = (suggestion, idx) => {
            const score = suggestion.score ? `${Math.round(suggestion.score * 100)}%` : '—';
            const repo = suggestion.repo_id || 'unknown repo';
            const filename = suggestion.actual_filename || suggestion.filename;
            return `${idx + 1}. ${filename} (${repo}, ${score})`;
        };

        select.appendChild($el("option", {
            value: '',
            textContent: '-- Select a suggested match --'
        }));

        suggestions.forEach((suggestion, idx) => {
            select.appendChild($el("option", {
                value: String(idx),
                textContent: formatLabel(suggestion, idx)
            }));
        });

        const applySelection = (selectedIndex) => {
            if (selectedIndex === -1) {
                model.selected_suggestion_index = undefined;
                model.url = null;
                model.expected_filename = null;
                model.actual_filename = null;
                model.url_source = null;
            } else {
                const suggestion = suggestions[selectedIndex];
                model.selected_suggestion_index = selectedIndex;
                model.url = suggestion.download_url;
                model.expected_filename = suggestion.expected_filename || suggestion.actual_filename;
                model.actual_filename = suggestion.actual_filename;
                model.url_source = 'hf_suggestion';
                model.has_exact_hf_match = false;
            }
            if (typeof onChange === 'function') {
                onChange();
            }
        };

        select.addEventListener('change', (event) => {
            const value = event.target.value;
            const selectedIndex = value === '' ? -1 : parseInt(value, 10);
            applySelection(Number.isNaN(selectedIndex) ? -1 : selectedIndex);
        });

        let defaultIndex = typeof model.selected_suggestion_index === 'number'
            ? model.selected_suggestion_index
            : -1;
        if (defaultIndex < 0 && model.url) {
            defaultIndex = suggestions.findIndex((s) => s.download_url === model.url);
        }
        if (defaultIndex >= 0 && defaultIndex < suggestions.length) {
            select.value = String(defaultIndex);
            if (model.selected_suggestion_index !== defaultIndex) {
                model.selected_suggestion_index = defaultIndex;
            }
        } else {
            select.value = '';
        }

        container.appendChild(label);
        container.appendChild(select);
        return container;
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
                const usageList = Array.isArray(model.related_usages) && model.related_usages.length > 0
                    ? model.related_usages
                    : [this._buildUsageMetadataFromModel(model)];

                const corrections = usageList
                    .filter(usage => usage && usage.node_id !== undefined && usage.node_id !== null)
                    .map(usage => ({
                        ...result.correction,
                        node_id: usage.node_id,
                        node_type: usage.node_type,
                        correction_type: usage.correction_type,
                        widget_index: usage.widget_index,
                        property_index: usage.property_index
                    }));

                if (corrections.length > 0) {
                    this.applyCorrectionsToGraph(corrections);
                }
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

        pollEndpoint(
            `/download-missing/status/${encodeURIComponent(pollKey)}`,
            (data) => {
                if (data.status === 'success' && data.progress) {
                    const progress = data.progress;

                    if (this.uiFrozen) {
                        this.pendingProgressUpdates.set(model.name, { model, progress });
                        return;
                    }

                    this.pendingProgressUpdates.delete(model.name);
                    this.applyProgressUpdate(model, progress);
                }
            },
            (data) => {
                return data.status === 'success' && data.progress &&
                       ['completed', 'error', 'cancelled'].includes(data.progress.status);
            },
            500,
            (error) => console.error("[Missing Models] Poll error:", error)
        );
    }

    applyProgressUpdate(model, progress) {
        this.scheduleDomUpdate(() => {
            const progressFill = model._progressBar?.querySelector('.progress-fill');

            if (progressFill) {
                progressFill.style.width = `${progress.progress}%`;
            }

            if (progress.status === 'downloading') {
                const downloadedMB = (progress.downloaded / (1024 * 1024)).toFixed(2);
                const totalMB = (progress.total / (1024 * 1024)).toFixed(2);
                model._statusText.textContent = `Downloading: ${downloadedMB} MB / ${totalMB} MB (${progress.progress}%)`;
                model._statusText.style.color = COLORS.PROGRESS_GREEN;
                if (progressFill) {
                    progressFill.classList.add('progress-downloading');
                }
            } else if (progress.status === 'completed') {
                this.downloadingModels.delete(model.name);
                if (progressFill) {
                    progressFill.classList.remove('progress-downloading');
                }
                model._statusText.textContent = 'Download completed!';
                model._statusText.style.color = COLORS.PROGRESS_GREEN;
                model._downloadButton.textContent = "Completed";
                model._downloadButton.style.backgroundColor = COLORS.PRIMARY_GREEN;
                model._card.style.opacity = '0.7';
                this.updateDownloadAllButtonState();
            } else if (progress.status === 'error') {
                this.downloadingModels.delete(model.name);
                model._statusText.textContent = `Error: ${progress.error || 'Unknown error'}`;
                model._statusText.style.color = COLORS.ERROR_RED;
                model._downloadButton.textContent = "Failed";
                model._downloadButton.disabled = true;
                if (progressFill) {
                    progressFill.classList.remove('progress-downloading');
                }
                this.updateDownloadAllButtonState();
            } else if (progress.status === 'cancelled') {
                this.downloadingModels.delete(model.name);
                model._statusText.textContent = 'Download cancelled';
                model._statusText.style.color = COLORS.WARNING_ORANGE;
                model._downloadButton.textContent = "Download";
                model._downloadButton.disabled = false;
                if (progressFill) {
                    progressFill.classList.remove('progress-downloading');
                }
                this.updateDownloadAllButtonState();
            }
        });
    }

    flushPendingProgressUpdates() {
        if (this.pendingProgressUpdates.size === 0) {
            return;
        }
        const pending = Array.from(this.pendingProgressUpdates.values());
        this.pendingProgressUpdates.clear();
        pending.forEach(({ model, progress }) => this.applyProgressUpdate(model, progress));
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
        this.scheduleDomUpdate(() => {
            this.statusElement.innerHTML = '';
            this.statusElement.appendChild(
                $el("span", {
                    textContent: message,
                    style: {
                        color: STATUS_COLORS[type] || COLORS.LIGHT_GRAY
                    }
                })
            );
        });
    }

    async show() {
        // Reset state from previous run
        this.missingModels = [];
        this.notFoundModels = [];
        this.correctedModels = [];
        this.downloadingModels.clear();
        this.pendingProgressUpdates.clear();
        this.domUpdateQueue = [];
        this.uiFrozen = false;
        this.isMouseDown = false;
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

        // Clean up drag listeners
        if (this.modelsListElement && this.mouseDownHandler) {
            this.modelsListElement.removeEventListener('mousedown', this.mouseDownHandler);
        }
        if (this.mouseUpHandler) {
            document.removeEventListener('mouseup', this.mouseUpHandler);
            this.mouseUpHandler = null;
        }

        // Reset freeze state
        this.uiFrozen = false;
        this.isMouseDown = false;
        this.pendingProgressUpdates.clear();
        this.domUpdateQueue = [];

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

    _buildUsageMetadataFromModel(model) {
        return {
            node_id: model.node_id,
            node_type: model.node_type,
            correction_type: model.correction_type,
            widget_index: model.widget_index,
            property_index: model.property_index
        };
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
