(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	/* ── Helpers ──────────────────────────────────────────────────────────── */

	function formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function formatResetCountdown(timestampMs) {
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0m';
		const totalMinutes = Math.round(diffMs / (1000 * 60));
		if (totalMinutes < 60) return `${totalMinutes}m`;
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	/** Return the right colour for a utilization percentage */
	function usageColor(pct) {
		if (pct >= 80) return '#ef4444'; // red
		if (pct >= 60) return '#facc15'; // yellow
		return '#4ade80';                // green
	}

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();
			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;
			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;
			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%)';
		};

		const hide = () => {
			tooltip.style.opacity = '0';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});
		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => { clearTimeout(pressTimer); hide(); });
		element.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(); });
		element.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'bg-bg-500 text-text-000 cc-tooltip';
		tip.textContent = text;
		document.body.appendChild(tip);
		return tip;
	}

	/* ── CounterUI ────────────────────────────────────────────────────────── */

	class CounterUI {
		constructor({ onUsageRefresh } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;

			// Header (tokens + cache) — unchanged
			this.headerContainer = null;
			this.headerDisplay = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.cachedDisplay = null;
			this.lengthBar = null;
			this.lengthTooltip = null;
			this.lastCachedUntilMs = null;
			this.pendingCache = false;
			this.cacheTimeSpan = null;

			// Usage panel elements
			this.usageLine = null;
			this.sessionUsageSpan = null;
			this.weeklyUsageSpan = null;
			this.sessionBar = null;
			this.sessionBarFill = null;
			this.weeklyBar = null;
			this.weeklyBarFill = null;
			this.sessionResetMs = null;
			this.weeklyResetMs = null;
			this.sessionMarker = null;
			this.weeklyMarker = null;
			this.sessionWindowStartMs = null;
			this.weeklyWindowStartMs = null;
			this.refreshingUsage = false;

			// Groups (needed for cc-hidden toggling)
			this.sessionGroup = null;
			this.weeklyGroup = null;

			this.domObserver = null;
		}

		/* Theme helpers — kept for header bar colours */
		getProgressChrome() {
			const root = document.documentElement;
			const isDark = root.dataset?.mode === 'dark';
			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT
			};
		}

		refreshProgressChrome() {
			const { strokeColor, fillColor, markerColor } = this.getProgressChrome();
			const applyBarChrome = (bar, { fillWarn } = {}) => {
				if (!bar) return;
				bar.style.setProperty('--cc-stroke', strokeColor);
				bar.style.setProperty('--cc-fill', fillColor);
				bar.style.setProperty('--cc-fill-warn', fillWarn ?? fillColor);
				bar.style.setProperty('--cc-marker', markerColor);
			};
			applyBarChrome(this.lengthBar, { fillWarn: fillColor });
			// session/weekly bars use CSS-defined colours — no override needed
		}

		initialize() {
			// ── Token / cache header ──────────────────────────────────────────
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'text-text-500 text-xs !px-1 cc-header';

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem';

			this.lengthGroup = document.createElement('span');
			this.lengthDisplay = document.createElement('span');
			this.cachedDisplay = document.createElement('span');
			this.cacheTimeSpan = null;

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			// ── Usage panel ───────────────────────────────────────────────────
			this._initUsageLine();
			this._setupTooltips();
			this._observeDom();
			this._attachSidebarVisibilityObserver();
			this._observeTheme();
		}

		_observeTheme() {
			const observer = new MutationObserver(() => this.refreshProgressChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			let usageReattachPending = false;
			let headerReattachPending = false;

			this.domObserver = new MutationObserver(() => {
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);

				if (usageMissing && !usageReattachPending) {
					usageReattachPending = true;
					CC.waitForElement(CC.DOM.MODEL_SELECTOR_DROPDOWN, 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}
				if (headerMissing && !headerReattachPending) {
					headerReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}

				// Watch for sidebar appearing and attach ResizeObserver
				this._attachSidebarVisibilityObserver();
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });

			// Also try immediately in case sidebar already exists
			this._attachSidebarVisibilityObserver();
		}

		_attachSidebarVisibilityObserver() {
			const sidebar = document.querySelector('nav[aria-label="Sidebar"]');
			if (!sidebar || sidebar.__ccVisibilityObserver) return;
			sidebar.__ccVisibilityObserver = true;

			document.addEventListener('click', (e) => {
				const btn = e.target.closest('[data-testid="pin-sidebar-toggle"]');
				if (!btn || !this.usageLine) return;
				// If sidebar is currently visible, it's about to close — hide immediately
				const isOpen = sidebar.offsetWidth > 50;
				this.usageLine.style.display = isOpen ? 'none' : '';
			}, true);

			const ro = new ResizeObserver(() => {
				if (!this.usageLine) return;
				this.usageLine.style.display = sidebar.offsetWidth > 50 ? '' : 'none';
			});
			ro.observe(sidebar);
		}

		/* ── Build the usage panel DOM ─────────────────────────────────────── */
		_initUsageLine() {
			// Outer wrapper
			this.usageLine = document.createElement('div');
			this.usageLine.className = 'cc-usageRow cc-hidden';

			// "USAGE" heading
			const heading = document.createElement('div');
			heading.className = 'cc-usageHeading';
			heading.textContent = 'USAGE';
			this.usageLine.appendChild(heading);

			// ── Session row ───────────────────────────────────────────────────
			this.sessionGroup = this._makeMetricRow(
				'5-hour session',
				(span, bar, fill, marker) => {
					this.sessionUsageSpan = span;
					this.sessionBar = bar;
					this.sessionBarFill = fill;
					this.sessionMarker = marker;
				}
			);
			this.usageLine.appendChild(this.sessionGroup);

			// ── Weekly row ────────────────────────────────────────────────────
			this.weeklyGroup = this._makeMetricRow(
				'7-day',
				(span, bar, fill, marker) => {
					this.weeklyUsageSpan = span;
					this.weeklyBar = bar;
					this.weeklyBarFill = fill;
					this.weeklyMarker = marker;
				}
			);
			this.usageLine.appendChild(this.weeklyGroup);

			// Click to refresh (same behaviour as before)
			this.usageLine.addEventListener('click', async () => {
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.usageLine.classList.add('cc-usageRow--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.usageLine.classList.remove('cc-usageRow--dim');
					this.refreshingUsage = false;
				}
			});
		}

		/** Creates one labelled metric row; calls assignRefs(span, bar, fill, marker) */
		_makeMetricRow(labelText, assignRefs) {
			const group = document.createElement('div');
			group.className = 'cc-usageGroup';

			// Label row
			const labelRow = document.createElement('div');
			labelRow.className = 'cc-usageLabelRow';

			const label = document.createElement('span');
			label.className = 'cc-usageLabel';
			label.textContent = labelText;

			const valueSpan = document.createElement('span');
			valueSpan.className = 'cc-usageText';

			labelRow.appendChild(label);
			labelRow.appendChild(valueSpan);
			group.appendChild(labelRow);

			// Bar
			const bar = document.createElement('div');
			bar.className = 'cc-bar';

			const fill = document.createElement('div');
			fill.className = 'cc-bar__fill';

			const marker = document.createElement('div');
			marker.className = 'cc-bar__marker cc-hidden';
			marker.style.left = '0%';

			bar.appendChild(fill);
			bar.appendChild(marker);
			group.appendChild(bar);

			assignRefs(valueSpan, bar, fill, marker);
			return group;
		}

		_setupTooltips() {
			this.lengthTooltip = makeTooltip(
				"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nBecomes invalid after context compaction.\nBar scale: 200k tokens (Claude's maximum context length, will compact before then)."
			);
			setupTooltip(this.lengthGroup, this.lengthTooltip, { topOffset: 8 });
			setupTooltip(this.cachedDisplay, makeTooltip('Messages sent while cached are significantly cheaper.'), { topOffset: 8 });
			setupTooltip(this.sessionGroup, makeTooltip('5-hour session window.\nThe bar shows your usage.\nThe line marks where you are in the window.'), { topOffset: 8 });
			setupTooltip(this.weeklyGroup, makeTooltip('7-day usage window.\nThe bar shows your usage.\nThe line marks where you are in the window.'), { topOffset: 8 });
		}

		/* ── Attach to Claude's sidebar ────────────────────────────────────── */

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		attachHeader() {
			const chatMenu = document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
			if (!chatMenu) return;
			const anchor = chatMenu.closest(CC.DOM.CHAT_PROJECT_WRAPPER) || chatMenu.parentElement;
			if (!anchor) return;
			if (anchor.nextElementSibling !== this.headerContainer) {
				anchor.after(this.headerContainer);
			}
			this._renderHeader();
			this.refreshProgressChrome();
		}

		attachUsageLine() {
			if (!this.usageLine) return;

			// ── Try to inject below the "Claude" wordmark at the top of sidebar
			// The sidebar nav starts with a header that contains the logo.
			// Walk up from any nav element and look for the topmost container.
			const sidebar = document.querySelector('nav[aria-label="Sidebar"]');
			if (sidebar && sidebar.offsetWidth > 0) {
				// Insert as the very first child of the sidebar (below the logo row)
				const firstChild = sidebar.firstElementChild;
				if (firstChild && firstChild !== this.usageLine) {
					sidebar.insertBefore(this.usageLine, firstChild.nextElementSibling || firstChild);
				} else if (!firstChild) {
					sidebar.appendChild(this.usageLine);
				}
				return;
			}

			// Fallback: below toolbar row (same as Chrome version)
			const modelSelector = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
			if (!modelSelector) return;
			const gridContainer = modelSelector.closest('[data-testid="chat-input-grid-container"]');
			const gridArea = modelSelector.closest('[data-testid="chat-input-grid-area"]');
			const findToolbarRow = (el, stopAt) => {
				let cur = el;
				while (cur && cur !== document.body) {
					if (stopAt && cur === stopAt) break;
					if (cur !== el && cur.nodeType === 1) {
						const style = window.getComputedStyle(cur);
						if (style.display === 'flex' && style.flexDirection === 'row') {
							if (cur.querySelectorAll('button').length > 1) return cur;
						}
					}
					cur = cur.parentElement;
				}
				return null;
			};
			const toolbarRow =
				(gridContainer ? findToolbarRow(modelSelector, gridArea || gridContainer) : null) ||
				findToolbarRow(modelSelector) ||
				modelSelector.parentElement?.parentElement?.parentElement;
			if (!toolbarRow) return;
			if (toolbarRow.nextElementSibling !== this.usageLine) {
				toolbarRow.after(this.usageLine);
			}
		}

		/* ── Data setters (logic unchanged) ───────────────────────────────── */

		setPendingCache(pending) {
			this.pendingCache = pending;
			if (this.cacheTimeSpan) {
				if (pending) {
					this.cacheTimeSpan.style.color = '';
				} else {
					const { boldColor } = this.getProgressChrome();
					this.cacheTimeSpan.style.color = boldColor;
				}
			}
		}

		setConversationMetrics({ totalTokens, cachedUntil } = {}) {
			this.pendingCache = false;

			if (typeof totalTokens !== 'number') {
				this.lengthDisplay.textContent = '';
				this.cachedDisplay.textContent = '';
				this.lastCachedUntilMs = null;
				this._renderHeader();
				return;
			}

			const pct = Math.max(0, Math.min(100, (totalTokens / CC.CONST.CONTEXT_LIMIT_TOKENS) * 100));
			this.lengthDisplay.textContent = `~${totalTokens.toLocaleString()} tokens`;

			const isFull = pct >= 99.5;
			if (isFull) {
				this.lengthDisplay.style.opacity = '0.5';
				this.lengthBar = null;
				this.lengthGroup.replaceChildren(this.lengthDisplay);
				if (this.lengthTooltip) {
					this.lengthTooltip.textContent =
						"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nThis count is invalid after compaction.";
				}
			} else {
				this.lengthDisplay.style.opacity = '';
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--mini';
				this.lengthBar = bar;
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				fill.style.width = `${pct}%`;
				bar.appendChild(fill);
				this.refreshProgressChrome();
				const barContainer = document.createElement('span');
				barContainer.className = 'inline-flex items-center';
				barContainer.appendChild(bar);
				this.lengthGroup.replaceChildren(this.lengthDisplay, document.createTextNode('\u00A0\u00A0'), barContainer);
			}

			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				const { boldColor } = this.getProgressChrome();
				this.cacheTimeSpan = Object.assign(document.createElement('span'), {
					className: 'cc-cacheTime',
					textContent: formatSeconds(secondsLeft)
				});
				this.cacheTimeSpan.style.color = boldColor;
				this.cachedDisplay.replaceChildren(document.createTextNode('cached for\u00A0'), this.cacheTimeSpan);
			} else {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.cachedDisplay.textContent = '';
			}

			this._renderHeader();
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();
			const hasTokens = !!this.lengthDisplay.textContent;
			const hasCache = !!this.cachedDisplay.textContent;
			if (!hasTokens) return;
			if (hasCache) {
				const gap = this.lengthBar ? '\u00A0\u00A0' : '\u00A0';
				this.headerDisplay.replaceChildren(this.lengthGroup, document.createTextNode(gap), this.cachedDisplay);
			} else {
				this.headerDisplay.replaceChildren(this.lengthGroup);
			}
			this.headerContainer.appendChild(this.headerDisplay);
		}

		setUsage(usage) {
			this.refreshProgressChrome();
			const session = usage?.five_hour || null;
			const weekly = usage?.seven_day || null;
			const hasAnyUsage =
				!!(session && typeof session.utilization === 'number') ||
				!!(weekly && typeof weekly.utilization === 'number');

			this.usageLine?.classList.toggle('cc-hidden', !hasAnyUsage);

			// ── Session ───────────────────────────────────────────────────────
			if (session && typeof session.utilization === 'number') {
				const rawPct = session.utilization;
				const pct = Math.round(rawPct * 10) / 10;

				this.sessionResetMs = session.resets_at ? Date.parse(session.resets_at) : null;
				this.sessionWindowStartMs = this.sessionResetMs ? this.sessionResetMs - 5 * 60 * 60 * 1000 : null;

				const resetText = this.sessionResetMs ? ` · ${formatResetCountdown(this.sessionResetMs)}` : '';
				this.sessionUsageSpan.textContent = `${pct}%${resetText}`;
				this.sessionUsageSpan.style.color = usageColor(rawPct);

				const width = Math.max(0, Math.min(100, rawPct));
				this.sessionBarFill.style.width = `${width}%`;
				this.sessionBarFill.classList.toggle('cc-warn', width >= 60 && width < 80);
				this.sessionBarFill.classList.toggle('cc-full', width >= 80);
				this.sessionGroup.classList.remove('cc-hidden');
			} else {
				this.sessionUsageSpan.textContent = '';
				this.sessionBarFill.style.width = '0%';
				this.sessionBarFill.classList.remove('cc-warn', 'cc-full');
				this.sessionResetMs = null;
				this.sessionWindowStartMs = null;
				this.sessionGroup.classList.add('cc-hidden');
			}

			// ── Weekly ────────────────────────────────────────────────────────
			const hasWeekly = weekly && typeof weekly.utilization === 'number';
			this.weeklyGroup?.classList.toggle('cc-hidden', !hasWeekly);

			if (hasWeekly) {
				const rawPct = weekly.utilization;
				const pct = Math.round(rawPct * 10) / 10;

				this.weeklyResetMs = weekly.resets_at ? Date.parse(weekly.resets_at) : null;
				this.weeklyWindowStartMs = this.weeklyResetMs ? this.weeklyResetMs - 7 * 24 * 60 * 60 * 1000 : null;

				const resetText = this.weeklyResetMs ? ` · ${formatResetCountdown(this.weeklyResetMs)}` : '';
				this.weeklyUsageSpan.textContent = `${pct}%${resetText}`;
				this.weeklyUsageSpan.style.color = usageColor(rawPct);

				const width = Math.max(0, Math.min(100, rawPct));
				this.weeklyBarFill.style.width = `${width}%`;
				this.weeklyBarFill.classList.toggle('cc-warn', width >= 60 && width < 80);
				this.weeklyBarFill.classList.toggle('cc-full', width >= 80);
			} else {
				this.weeklyBarFill?.classList.remove('cc-warn', 'cc-full');
				this.weeklyResetMs = null;
				this.weeklyWindowStartMs = null;
			}

			this._updateMarkers();
		}

		_updateMarkers() {
			const now = Date.now();

			if (this.sessionMarker && this.sessionWindowStartMs && this.sessionResetMs) {
				const total = this.sessionResetMs - this.sessionWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.sessionWindowStartMs));
				const pct = total > 0 ? Math.max(0, Math.min(100, (elapsed / total) * 100)) : 0;
				this.sessionMarker.classList.remove('cc-hidden');
				this.sessionMarker.style.left = `${pct}%`;
			} else if (this.sessionMarker) {
				this.sessionMarker.classList.add('cc-hidden');
			}

			if (this.weeklyMarker && this.weeklyWindowStartMs && this.weeklyResetMs) {
				const total = this.weeklyResetMs - this.weeklyWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.weeklyWindowStartMs));
				const pct = total > 0 ? Math.max(0, Math.min(100, (elapsed / total) * 100)) : 0;
				this.weeklyMarker.classList.remove('cc-hidden');
				this.weeklyMarker.style.left = `${pct}%`;
			} else if (this.weeklyMarker) {
				this.weeklyMarker.classList.add('cc-hidden');
			}
		}

		/* ── Per-second tick (countdowns + markers) ──────────────────────── */

		tick() {
			const now = Date.now();

			// Cache countdown
			if (this.lastCachedUntilMs && this.lastCachedUntilMs > now) {
				const secondsLeft = Math.max(0, Math.ceil((this.lastCachedUntilMs - now) / 1000));
				if (this.cacheTimeSpan) this.cacheTimeSpan.textContent = formatSeconds(secondsLeft);
			} else if (this.lastCachedUntilMs && this.lastCachedUntilMs <= now) {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.pendingCache = false;
				this.cachedDisplay.textContent = '';
				this._renderHeader();
			}

			// Session reset countdown
			if (this.sessionResetMs && this.sessionUsageSpan?.textContent) {
				const idx = this.sessionUsageSpan.textContent.indexOf('· ');
				if (idx !== -1) {
					const prefix = this.sessionUsageSpan.textContent.slice(0, idx + 2);
					this.sessionUsageSpan.textContent = `${prefix}${formatResetCountdown(this.sessionResetMs)}`;
				}
			}

			// Weekly reset countdown
			if (this.weeklyResetMs && this.weeklyUsageSpan?.textContent) {
				const idx = this.weeklyUsageSpan.textContent.indexOf('· ');
				if (idx !== -1) {
					const prefix = this.weeklyUsageSpan.textContent.slice(0, idx + 2);
					this.weeklyUsageSpan.textContent = `${prefix}${formatResetCountdown(this.weeklyResetMs)}`;
				}
			}

			this._updateMarkers();
		}
	}

	CC.ui = { CounterUI };
})();
