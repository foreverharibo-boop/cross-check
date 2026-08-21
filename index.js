import { extension_settings } from "../../../extensions.js";

const MODULE_NAME = "crosscheck";
const PCC_MODULE_NAME = "persistent-custom-css";
const PCC_STYLE_ID = "persistent-custom-css-style";
const MAX_RESULTS = 60;
const VISIBLE_RESULTS_PER_SECTION = 6;
const MAX_ERRORS = 30;

const defaultSettings = {};

let latestReport = null;
let styleMutationObserver = null;
const recentErrors = [];
const recentStyleChanges = [];

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!(key in settings)) settings[key] = value;
    }
    return settings;
}

function normalizedExtensionPath(value) {
    return String(value || "")
        .replace(/^\/+/g, "")
        .replace(/^scripts\/extensions\//i, "")
        .replace(/\/$/, "");
}

function disabledExtensionNames() {
    const candidates = [
        extension_settings.disabledExtensions,
        extension_settings.disabled_extensions,
        extension_settings.disabled,
    ];
    const disabled = candidates.find(Array.isArray) || [];
    return new Set(disabled.flatMap(value => {
        const path = normalizedExtensionPath(value);
        const basename = path.split("/").pop();
        return [path, basename].filter(Boolean);
    }));
}

function isExtensionDisabled(path) {
    const normalized = normalizedExtensionPath(path);
    const disabled = disabledExtensionNames();
    return disabled.has(normalized) || disabled.has(normalized.split("/").pop());
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function normalizeWhitespace(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function shortText(value, length = 180) {
    const text = normalizeWhitespace(value);
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function setStatus(message) {
    $("#crosscheck-status").text(message || "");
}

function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function splitSelectors(selectorText) {
    const selectors = [];
    let current = "";
    let depth = 0;
    let quote = "";
    let escaped = false;

    for (const char of String(selectorText ?? "")) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            current += char;
            escaped = true;
            continue;
        }
        if (quote) {
            current += char;
            if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'") {
            current += char;
            quote = char;
            continue;
        }
        if (char === "(" || char === "[") depth += 1;
        if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
        if (char === "," && depth === 0) {
            if (current.trim()) selectors.push(current.trim());
            current = "";
            continue;
        }
        current += char;
    }
    if (current.trim()) selectors.push(current.trim());
    return selectors;
}

function isInterestingSource(source) {
    return ["persistent", "extension", "theme", "custom"].includes(source?.kind);
}

function sourceFromStyleSheet(sheet, index) {
    const owner = sheet.ownerNode;
    const href = sheet.href || owner?.href || "";
    const ownerId = owner?.id || "";

    if (ownerId === PCC_STYLE_ID) {
        return { key: "persistent-combined", label: "등록 CSS(결합본)", kind: "persistent", skip: true };
    }

    if (href) {
        let pathname = href;
        try {
            pathname = new URL(href, location.href).pathname;
        } catch {
            // 원본 문자열을 그대로 사용
        }
        const extensionMatch = pathname.match(/\/scripts\/extensions\/((?:third-party\/)?[^/]+)\/(.+)$/i);
        if (extensionMatch) {
            const extensionPath = decodeURIComponent(extensionMatch[1]);
            const file = decodeURIComponent(extensionMatch[2]);
            return {
                key: `extension:${extensionPath}:${file}`,
                label: `확장 CSS · ${extensionPath} / ${file}`,
                kind: "extension",
                extensionPath,
                href,
            };
        }
        if (/theme|themes/i.test(pathname)) {
            return { key: `theme:${pathname}`, label: `테마 CSS · ${pathname.split("/").pop()}`, kind: "theme", href };
        }
        return { key: `core:${pathname}`, label: `SillyTavern · ${pathname.split("/").pop()}`, kind: "core", href };
    }

    if (/theme/i.test(ownerId) || ownerId === "custom-style" || /theme/i.test(owner?.dataset?.name || "")) {
        return {
            key: `theme:${ownerId || index}`,
            label: `사용자/테마 CSS · ${ownerId || `inline-${index + 1}`}`,
            kind: "theme",
        };
    }

    if (/custom|user/i.test(ownerId) || /custom|user/i.test(owner?.dataset?.name || "")) {
        return {
            key: `custom:${ownerId || index}`,
            label: `사용자/테마 CSS · ${ownerId || `inline-${index + 1}`}`,
            kind: "custom",
        };
    }

    const hint = ownerId ? `#${ownerId}` : owner?.dataset?.extension || `inline-${index + 1}`;
    return { key: `inline:${hint}`, label: `인라인 CSS · ${hint}`, kind: "inline" };
}

function isCrosscheckSource(source) {
    return /(?:^|\/)(?:crosscheck|CrossCheck-main)(?:\/|:|$)/i.test(source?.key || "")
        || /크로스체크/.test(source?.label || "");
}

function mediaIsActive(mediaText) {
    if (!mediaText || mediaText === "all") return true;
    try {
        return window.matchMedia(mediaText).matches;
    } catch {
        return true;
    }
}

function walkCssRules(ruleList, source, state, output, diagnostics) {
    for (const rule of Array.from(ruleList || [])) {
        state.order += 1;

        if (rule.type === CSSRule.STYLE_RULE) {
            const selectors = splitSelectors(rule.selectorText);
            for (const selector of selectors) {
                if (!selector || selector.startsWith("#crosscheck")) continue;
                for (const property of Array.from(rule.style || [])) {
                    const value = rule.style.getPropertyValue(property).trim();
                    if (!value) continue;
                    output.push({
                        selector,
                        normalizedSelector: normalizeWhitespace(selector),
                        property,
                        value,
                        important: rule.style.getPropertyPriority(property) === "important",
                        active: state.active,
                        disabledSource: state.disabledSource,
                        media: state.media,
                        source,
                        order: state.order,
                    });
                }
            }
            continue;
        }

        if (rule.type === CSSRule.MEDIA_RULE) {
            const condition = rule.conditionText || rule.media?.mediaText || "";
            const nestedState = {
                ...state,
                active: state.active && mediaIsActive(condition),
                media: condition,
            };
            walkCssRules(rule.cssRules, source, nestedState, output, diagnostics);
            state.order = Math.max(state.order, nestedState.order);
            continue;
        }

        if (rule.type === CSSRule.SUPPORTS_RULE) {
            let supported = true;
            try {
                supported = CSS.supports(rule.conditionText);
            } catch {
                supported = true;
            }
            const nestedState = { ...state, active: state.active && supported };
            walkCssRules(rule.cssRules, source, nestedState, output, diagnostics);
            state.order = Math.max(state.order, nestedState.order);
            continue;
        }

        if (rule.type === CSSRule.KEYFRAMES_RULE) {
            diagnostics.keyframes.push({
                name: rule.name,
                cssText: rule.cssText,
                source,
                active: state.active,
            });
            continue;
        }

        if (rule.cssRules) {
            const nestedState = { ...state };
            walkCssRules(rule.cssRules, source, nestedState, output, diagnostics);
            state.order = Math.max(state.order, nestedState.order);
        }
    }
}

function parseCssText(cssText, source, active, orderStart, diagnostics) {
    const output = [];
    const state = { order: orderStart, active, disabledSource: !active, media: "" };

    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(cssText);
        walkCssRules(sheet.cssRules, source, state, output, diagnostics);
        return { rules: output, order: state.order };
    } catch (firstError) {
        const style = document.createElement("style");
        style.media = "not all";
        style.dataset.crosscheckParser = "true";
        style.textContent = cssText;
        document.head.appendChild(style);
        try {
            walkCssRules(style.sheet?.cssRules, source, state, output, diagnostics);
            return { rules: output, order: state.order };
        } catch (secondError) {
            diagnostics.parseErrors.push({ source, message: secondError?.message || firstError?.message || "CSS를 해석할 수 없음" });
            return { rules: output, order: state.order };
        } finally {
            style.remove();
        }
    }
}

function collectPersistentCssRules(orderStart, diagnostics) {
    const pcc = extension_settings[PCC_MODULE_NAME];
    if (!pcc || !Array.isArray(pcc.entries)) {
        return { rules: [], order: orderStart, entryCount: 0, activeEntryCount: 0 };
    }

    const folderMap = new Map((Array.isArray(pcc.folders) ? pcc.folders : []).map(folder => [folder.id, folder.title || "이름 없는 폴더"]));
    const output = [];
    let order = orderStart;
    let activeEntryCount = 0;

    for (const [index, entry] of pcc.entries.entries()) {
        if (!entry?.css?.trim()) continue;
        if (!entry.enabled) continue;
        if (entry.enabled) activeEntryCount += 1;

        const folder = entry.folderId ? folderMap.get(entry.folderId) : "";
        const title = entry.title || `CSS ${index + 1}`;
        const path = folder ? `${folder} › ${title}` : title;
        const source = {
            key: `persistent:${entry.id || index}`,
            label: `등록 CSS · ${path}`,
            kind: "persistent",
            entryId: entry.id,
            entryTitle: title,
            folderTitle: folder,
            enabled: !!entry.enabled,
        };
        const parsed = parseCssText(entry.css, source, !!entry.enabled, order + 100, diagnostics);
        output.push(...parsed.rules);
        order = parsed.order + 100;
    }

    return {
        rules: output,
        order,
        entryCount: pcc.entries.filter(entry => entry?.css?.trim()).length,
        activeEntryCount,
    };
}

async function collectAllCssRules() {
    const output = [];
    const diagnostics = { inaccessibleSheets: [], parseErrors: [], keyframes: [] };
    let order = 0;
    let readableSheets = 0;
    const styleSheets = Array.from(document.styleSheets);

    for (const [index, sheet] of styleSheets.entries()) {
        const source = sourceFromStyleSheet(sheet, index);
        if (source.skip || isCrosscheckSource(source)) continue;
        if (source.kind === "extension" && isExtensionDisabled(source.extensionPath)) continue;

        const sheetMedia = sheet.media?.mediaText || "";
        const active = !sheet.disabled && mediaIsActive(sheetMedia);
        try {
            const state = { order, active, disabledSource: !active, media: sheetMedia };
            walkCssRules(sheet.cssRules, source, state, output, diagnostics);
            order = state.order + 100;
            readableSheets += 1;
        } catch (error) {
            diagnostics.inaccessibleSheets.push({
                source,
                message: error?.message || "브라우저가 스타일 규칙 접근을 차단함",
            });
        }

        if (index > 0 && index % 12 === 0) await nextFrame();
    }

    const persistent = collectPersistentCssRules(order + 10000, diagnostics);
    output.push(...persistent.rules);

    return {
        rules: output,
        diagnostics,
        sheetCount: styleSheets.length,
        readableSheets,
        persistent,
    };
}

function distinctSources(records) {
    return new Set(records.map(record => record.source.key));
}

function distinctDeclarations(records) {
    return new Set(records.map(record => `${record.property}:${normalizeWhitespace(record.value)}:${record.important}`));
}

function displayDeclaration(record) {
    return `${record.property}: ${shortText(record.value, 130)}${record.important ? " !important" : ""}`;
}

function shouldReportRuleConflict(records) {
    // SillyTavern 기본 CSS는 확장과 사용자 CSS가 덮어쓰라고 있는 기준값이므로 제외한다.
    // 현재 활성화된 테마·확장·등록 CSS끼리 실제로 경쟁하는 경우만 남긴다.
    const actors = records.filter(record => record.active && ["persistent", "extension", "theme", "custom"].includes(record.source.kind));
    if (distinctSources(actors).size < 2) return false;

    // !important 여부가 다르면 승자가 명확한 의도적 덮어쓰기다. 가장 높은 단계끼리만 비교한다.
    const importantWins = actors.some(record => record.important);
    const priorityActors = actors.filter(record => record.important === importantWins);
    if (distinctSources(priorityActors).size < 2) return false;

    // 같은 선택자끼리 묶였으므로 명시도는 동일하다. 같은 우선순위에서 값이 다르면
    // 마지막에 로드된 순서에 따라 결과가 달라지는 실제 CSS 경쟁이다.
    const values = new Set(priorityActors.map(record => normalizeWhitespace(record.value)));
    return values.size > 1;
}

function conflictResultsFromRules(rules) {
    const groups = new Map();

    for (const rule of rules.filter(rule => rule.active)) {
        const key = `${rule.normalizedSelector}\u0000${rule.property}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(rule);
    }

    const candidates = [];
    for (const records of groups.values()) {
        if (records.length < 2 || distinctSources(records).size < 2 || distinctDeclarations(records).size < 2) continue;
        if (!records.some(record => isInterestingSource(record.source))) continue;

        if (!shouldReportRuleConflict(records)) continue;
        const selector = records[0].selector;
        const property = records[0].property;
        const importantWins = records.some(record => record.active && record.important && ["persistent", "extension", "theme", "custom"].includes(record.source.kind));
        const sorted = records
            .filter(record => ["persistent", "extension", "theme", "custom"].includes(record.source.kind))
            .filter(record => record.important === importantWins)
            .sort((a, b) => a.order - b.order);
        const lines = sorted.slice(-6).map(record => ({
            source: record.source.label,
            text: `${displayDeclaration(record)}${record.media ? ` · @media ${record.media}` : ""}`,
        }));

        candidates.push({
            level: "high",
            title: "활성 CSS 로드 순서 충돌",
            selector,
            property,
            lines,
        });
    }

    // 같은 선택자에서 여러 속성이 겹쳐도 카드 하나로 묶어서 결과 폭증을 막는다.
    const aggregated = new Map();
    for (const item of candidates) {
        const key = `${item.level}\u0000${item.selector}`;
        if (!aggregated.has(key)) {
            aggregated.set(key, { ...item, properties: [], lines: [] });
        }
        const target = aggregated.get(key);
        target.properties.push(item.property);
        for (const line of item.lines) {
            const lineKey = `${line.source}\u0000${line.text}`;
            if (!target.lines.some(existing => `${existing.source}\u0000${existing.text}` === lineKey)) {
                target.lines.push(line);
            }
        }
    }

    return Array.from(aggregated.values())
        .map(item => ({
            level: item.level,
            title: `${item.title}${item.properties.length > 1 ? ` · ${item.properties.length}개 속성` : ""}`,
            meta: `${item.selector} · ${item.properties.slice(0, 8).join(", ")}${item.properties.length > 8 ? "…" : ""}`,
            lines: item.lines.slice(-10),
        }))
        .slice(0, MAX_RESULTS);
}

function keyframeResults(keyframes) {
    const groups = new Map();
    for (const item of keyframes) {
        if (!item.active || !["persistent", "extension", "theme", "custom"].includes(item.source.kind)) continue;
        if (!groups.has(item.name)) groups.set(item.name, []);
        groups.get(item.name).push(item);
    }
    return Array.from(groups.entries())
        .filter(([, items]) => distinctSources(items).size > 1 && new Set(items.map(item => normalizeWhitespace(item.cssText))).size > 1)
        .map(([name, items]) => ({
            level: "medium",
            title: "애니메이션 이름 중복",
            meta: `@keyframes ${name}`,
            lines: items.map(item => ({ source: item.source.label, text: "같은 애니메이션 이름을 등록함" })),
        }));
}

function extensionPathFromUrl(url) {
    try {
        const pathname = new URL(url, location.href).pathname;
        return decodeURIComponent(pathname.match(/\/scripts\/extensions\/((?:third-party\/)?[^/]+)\//i)?.[1] || "");
    } catch {
        return "";
    }
}

function discoverLoadedExtensionPaths() {
    const urls = new Set();
    document.querySelectorAll("script[src], link[href]").forEach(node => urls.add(node.src || node.href));
    for (const item of performance.getEntriesByType("resource")) urls.add(item.name);
    for (const sheet of Array.from(document.styleSheets)) if (sheet.href) urls.add(sheet.href);

    return Array.from(urls)
        .map(extensionPathFromUrl)
        .filter(Boolean)
        .filter(path => !/crosscheck|CrossCheck-main/i.test(path))
        .filter(path => !isExtensionDisabled(path))
        .filter((value, index, array) => array.indexOf(value) === index)
        .sort((a, b) => a.localeCompare(b));
}

async function loadExtensionManifests(paths) {
    const settled = await Promise.all(paths.map(async path => {
        try {
            const response = await fetch(`/scripts/extensions/${path}/manifest.json`, { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const manifest = await response.json();
            let jsText = "";
            let jsError = "";
            if (manifest.js) {
                try {
                    const jsUrl = new URL(String(manifest.js), `${location.origin}/scripts/extensions/${path}/`);
                    const jsResponse = await fetch(jsUrl, { cache: "no-store" });
                    if (!jsResponse.ok) throw new Error(`HTTP ${jsResponse.status}`);
                    jsText = await jsResponse.text();
                } catch (error) {
                    jsError = error?.message || "진입 JS를 읽을 수 없음";
                }
            }
            return { ok: true, path, manifest, jsText, jsError };
        } catch (error) {
            return { ok: false, path, message: error?.message || "manifest를 읽을 수 없음" };
        }
    }));

    const manifests = settled.filter(item => item.ok);
    const failures = settled.filter(item => !item.ok);
    return { manifests, failures };
}

function regexMatches(text, regex, captureIndex = 1) {
    const found = new Set();
    for (const match of String(text || "").matchAll(regex)) {
        if (match[captureIndex]) found.add(match[captureIndex]);
    }
    return Array.from(found);
}

function extensionCodeResults(manifests) {
    const globalNames = new Map();
    const settingKeys = new Map();
    const createdIds = new Map();

    function add(map, key, item) {
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
    }

    for (const item of manifests) {
        const code = item.jsText || "";
        if (!code) continue;
        const displayName = item.manifest.display_name || item.path;

        for (const name of regexMatches(code, /(?:globalThis|window)\.([A-Za-z_$][\w$]*)\s*=/g)) {
            add(globalNames, name, { ...item, displayName });
        }
        for (const key of regexMatches(code, /extension_settings\s*\[\s*["']([^"']+)["']\s*\]/g)) {
            add(settingKeys, key, { ...item, displayName });
        }
        for (const key of regexMatches(code, /extension_settings\.([A-Za-z_$][\w$]*)/g)) {
            add(settingKeys, key, { ...item, displayName });
        }
        for (const id of regexMatches(code, /\bid\s*=\s*["']([A-Za-z][\w:.-]*)["']/g)) {
            add(createdIds, id, { ...item, displayName });
        }
        for (const id of regexMatches(code, /\.id\s*=\s*["']([A-Za-z][\w:.-]*)["']/g)) {
            add(createdIds, id, { ...item, displayName });
        }

    }

    const results = [];
    for (const [name, items] of globalNames.entries()) {
        if (name.startsWith("__")) continue;
        const unique = new Map(items.filter(item => item.path.startsWith("third-party/")).map(item => [item.path, item]));
        if (unique.size < 2) continue;
        results.push({
            level: "high",
            title: "전역 JavaScript 이름 중복",
            meta: `window/globalThis.${name}을 여러 확장이 할당합니다. 나중에 로드된 확장이 앞의 값을 덮어쓸 수 있습니다.`,
            lines: Array.from(unique.values()).map(item => ({ source: item.displayName, text: item.path })),
        });
    }
    for (const [key, items] of settingKeys.entries()) {
        const unique = new Map(items.filter(item => item.path.startsWith("third-party/")).map(item => [item.path, item]));
        if (unique.size < 2) continue;
        results.push({
            level: "high",
            title: "확장 설정 저장 키 중복",
            meta: `extension_settings[${JSON.stringify(key)}]를 여러 확장이 사용합니다.`,
            lines: Array.from(unique.values()).map(item => ({ source: item.displayName, text: item.path })),
        });
    }
    for (const [id, items] of createdIds.entries()) {
        const unique = new Map(items.map(item => [item.path, item]));
        if (unique.size < 2) continue;
        results.push({
            level: "medium",
            title: "생성 DOM ID 중복 가능성",
            meta: `#${id}를 여러 확장 코드에서 생성합니다.`,
            lines: Array.from(unique.values()).map(item => ({ source: item.displayName, text: item.path })),
        });
    }
    return results.slice(0, 80);
}

function manifestResults(manifests, loadedPaths) {
    const results = [];
    const pathSet = new Set(loadedPaths);
    const interceptorGroups = new Map();
    const displayNameGroups = new Map();

    for (const item of manifests) {
        const manifest = item.manifest || {};
        if (manifest.generate_interceptor) {
            const name = manifest.generate_interceptor;
            if (!interceptorGroups.has(name)) interceptorGroups.set(name, []);
            interceptorGroups.get(name).push(item);
        }
        const displayName = manifest.display_name || item.path;
        if (!displayNameGroups.has(displayName)) displayNameGroups.set(displayName, []);
        displayNameGroups.get(displayName).push(item);

        for (const dependency of Array.isArray(manifest.dependencies) ? manifest.dependencies : []) {
            if (!pathSet.has(dependency)) {
                results.push({
                    level: "high",
                    title: "활성 의존 확장 확인 필요",
                    meta: `${displayName}에서 ${dependency}를 요구하지만 현재 로드 목록에서 찾지 못했습니다.`,
                    lines: [{ source: item.path, text: `dependencies: ${dependency}` }],
                });
            }
        }
    }

    for (const [name, items] of interceptorGroups.entries()) {
        if (items.length < 2) continue;
        results.push({
            level: "high",
            title: "생성 인터셉터 전역 이름 중복",
            meta: `${name}을 ${items.length}개 확장이 함께 등록했습니다.`,
            lines: items.map(item => ({
                source: item.manifest.display_name || item.path,
                text: `loading_order: ${item.manifest.loading_order ?? "미지정"}`,
            })),
        });
    }

    for (const [name, items] of displayNameGroups.entries()) {
        if (items.length < 2) continue;
        results.push({
            level: "medium",
            title: "확장 표시명 중복",
            meta: `${name}이라는 이름을 여러 확장이 사용합니다.`,
            lines: items.map(item => ({ source: item.path, text: "동일한 display_name" })),
        });
    }
    return results;
}

function errorResults() {
    return recentErrors.slice(-10).reverse().map(item => ({
        level: "high",
        title: item.type === "promise" ? "처리되지 않은 Promise 오류" : "최근 브라우저 오류",
        meta: item.message,
        lines: item.source ? [{ source: item.source, text: item.stack || item.message }] : [],
    }));
}

function buildReportText(report) {
    const lines = [
        `🔀 크로스체크 진단 결과`,
        `검사 시각: ${new Date(report.createdAt).toLocaleString()}`,
        `검사 기준: 현재 활성화된 확장과 등록 CSS만`,
        `활성 외부 확장: ${report.summary.extensions} / 활성 등록 CSS: ${report.summary.activeCssEntries} / CSS 충돌: ${report.summary.cssIssues} / JS 충돌: ${report.summary.jsIssues}`,
        "",
    ];

    for (const section of report.sections) {
        lines.push(`[${section.title}]`);
        if (!section.items.length) {
            lines.push("- 발견된 항목 없음", "");
            continue;
        }
        for (const item of section.items) {
            lines.push(`- ${item.title}: ${item.meta || ""}`.trim());
            for (const line of item.lines || []) lines.push(`  · ${line.source}: ${line.text}`);
        }
        lines.push("");
    }
    return lines.join("\n");
}

function reportItemHtml(item, extra = false) {
    const lines = (item.lines || []).map(line => `
        <div class="cc-rule-line"><span class="cc-source">${escapeHtml(line.source)}</span> — ${escapeHtml(line.text)}</div>
    `).join("");
    return `
        <div class="cc-result${extra ? " cc-extra-result" : ""}" data-level="${escapeHtml(item.level || "info")}">
            <div class="cc-result-title">${escapeHtml(item.title)}</div>
            ${item.meta ? `<div class="cc-result-meta">${escapeHtml(item.meta)}</div>` : ""}
            ${lines}
        </div>
    `;
}

function setImportantStyle(element, property, value) {
    element?.style?.setProperty(property, value, "important");
}

function enforceDialogLayout(open) {
    const overlay = document.querySelector("#crosscheck-overlay");
    const dialog = document.querySelector("#crosscheck-dialog");
    const body = document.querySelector("#crosscheck-dialog-body");
    const head = document.querySelector("#crosscheck-dialog .cc-dialog-head");
    const foot = document.querySelector("#crosscheck-dialog .cc-dialog-foot");
    if (!overlay || !dialog || !body || !head || !foot) return;

    const mobile = window.matchMedia("(max-width: 700px)").matches;
    const overlayStyles = {
        position: "fixed",
        top: "0",
        right: "0",
        bottom: "0",
        left: "0",
        width: "100vw",
        height: "100dvh",
        margin: "0",
        transform: "none",
        "box-sizing": "border-box",
        "z-index": "2147483646",
        display: open ? "flex" : "none",
        "align-items": "center",
        "justify-content": "center",
        padding: mobile ? "6px" : "12px",
        overflow: "hidden",
    };
    for (const [property, value] of Object.entries(overlayStyles)) setImportantStyle(overlay, property, value);

    const dialogStyles = {
        position: "relative",
        top: "auto",
        right: "auto",
        bottom: "auto",
        left: "auto",
        width: mobile ? "calc(100vw - 12px)" : "min(820px, calc(100vw - 24px))",
        height: mobile ? "calc(100dvh - 12px)" : "min(88dvh, 900px)",
        "max-width": mobile ? "none" : "820px",
        "max-height": "none",
        margin: "0",
        transform: "none",
        display: "flex",
        "flex-direction": "column",
        overflow: "hidden",
        "box-sizing": "border-box",
    };
    for (const [property, value] of Object.entries(dialogStyles)) setImportantStyle(dialog, property, value);
    setImportantStyle(body, "min-height", "0");
    setImportantStyle(body, "flex", "1 1 auto");
    setImportantStyle(body, "overflow", "auto");
    setImportantStyle(body, "position", "relative");
    setImportantStyle(body, "transform", "none");
    for (const fixedPart of [head, foot]) {
        setImportantStyle(fixedPart, "position", "relative");
        setImportantStyle(fixedPart, "top", "auto");
        setImportantStyle(fixedPart, "right", "auto");
        setImportantStyle(fixedPart, "bottom", "auto");
        setImportantStyle(fixedPart, "left", "auto");
        setImportantStyle(fixedPart, "width", "100%");
        setImportantStyle(fixedPart, "transform", "none");
        setImportantStyle(fixedPart, "flex", "0 0 auto");
    }
}

function renderReport(report) {
    latestReport = report;
    const body = document.querySelector("#crosscheck-dialog-body");
    document.querySelector("#crosscheck-dialog-title").textContent = "활성 확장 검사 결과";

    const sections = report.sections.map((section, sectionIndex) => `
        <section class="cc-section">
            <h3 class="cc-section-title">${escapeHtml(section.title)} (${section.items.length})</h3>
            ${section.items.length ? section.items.map((item, index) => reportItemHtml(item, index >= VISIBLE_RESULTS_PER_SECTION)).join("") : '<div class="cc-empty">발견된 항목이 없습니다.</div>'}
            ${section.items.length > VISIBLE_RESULTS_PER_SECTION ? `<button type="button" class="menu_button cc-show-more" data-section="${sectionIndex}" data-more="${section.items.length - VISIBLE_RESULTS_PER_SECTION}">${section.items.length - VISIBLE_RESULTS_PER_SECTION}개 더 보기</button>` : ""}
        </section>
    `).join("") || '<div class="cc-empty">현재 활성 상태에서 확인된 충돌이 없습니다.</div>';

    body.innerHTML = `
        <div class="cc-summary">
            <div class="cc-summary-card"><span class="cc-summary-number">${report.summary.extensions}</span><span class="cc-summary-label">활성 외부확장</span></div>
            <div class="cc-summary-card"><span class="cc-summary-number">${report.summary.activeCssEntries}</span><span class="cc-summary-label">활성 등록CSS</span></div>
            <div class="cc-summary-card"><span class="cc-summary-number">${report.summary.cssIssues}</span><span class="cc-summary-label">CSS 충돌</span></div>
            <div class="cc-summary-card"><span class="cc-summary-number">${report.summary.jsIssues}</span><span class="cc-summary-label">JS 충돌</span></div>
        </div>
        ${sections}
    `;
    body.scrollTop = 0;
    body.querySelectorAll(".cc-show-more").forEach(button => {
        button.addEventListener("click", () => {
            const section = button.closest(".cc-section");
            const expanded = section.classList.toggle("cc-expanded");
            button.textContent = expanded ? "접기" : `${button.dataset.more}개 더 보기`;
        });
    });
    document.querySelector("#crosscheck-overlay").classList.add("cc-open");
    enforceDialogLayout(true);
    const reopenButton = document.querySelector("#crosscheck-open-last");
    if (reopenButton) reopenButton.disabled = false;
}

function closeReport() {
    document.querySelector("#crosscheck-overlay")?.classList.remove("cc-open");
    enforceDialogLayout(false);
}

async function runFullScan() {
    const button = document.querySelector("#crosscheck-full-scan");
    if (button) button.disabled = true;
    setStatus("확장과 CSS를 검사하는 중…");

    try {
        const paths = discoverLoadedExtensionPaths();
        const css = await collectAllCssRules();
        await nextFrame();
        const thirdPartyPaths = paths.filter(path => path.startsWith("third-party/"));
        const manifestData = await loadExtensionManifests(thirdPartyPaths);
        const cssConflicts = conflictResultsFromRules(css.rules);
        const manifests = [
            ...manifestResults(manifestData.manifests, paths),
            ...extensionCodeResults(manifestData.manifests),
        ];
        const keyframes = keyframeResults(css.diagnostics.keyframes);
        const errors = errorResults();

        const cssItems = [...cssConflicts, ...keyframes];
        const sections = [
            { title: "활성 CSS 로드 순서 충돌", items: cssItems },
            { title: "활성 확장 JavaScript 충돌", items: manifests },
            { title: "최근 실행 오류", items: errors },
        ].filter(section => section.items.length > 0);
        const issues = sections.reduce((sum, section) => sum + section.items.length, 0);
        const activeThirdPartyExtensions = thirdPartyPaths.length;
        renderReport({
            createdAt: Date.now(),
            mode: "full",
            summary: {
                extensions: activeThirdPartyExtensions,
                activeCssEntries: css.persistent.activeEntryCount,
                cssIssues: cssItems.length,
                jsIssues: manifests.length,
            },
            sections,
            metadata: {
                persistentEntries: css.persistent.entryCount,
                activePersistentEntries: css.persistent.activeEntryCount,
                recentStyleChanges: recentStyleChanges.length,
            },
        });
        setStatus(issues ? `검사 완료 · 활성 충돌 ${issues}개` : "검사 완료 · 활성 충돌 없음");
    } catch (error) {
        console.error("[크로스체크] 전체 검사 실패", error);
        setStatus("검사 중 오류가 발생했습니다.");
        globalThis.toastr?.error?.(`크로스체크 검사 실패: ${error?.message || error}`);
    } finally {
        if (button) button.disabled = false;
    }
}

async function copyLatestReport() {
    if (!latestReport) return;
    try {
        await navigator.clipboard.writeText(buildReportText(latestReport));
        globalThis.toastr?.success?.("크로스체크 결과를 복사했습니다.");
    } catch {
        globalThis.toastr?.error?.("결과를 복사하지 못했습니다.");
    }
}

function addUi() {
    if (document.querySelector("#crosscheck-settings")) return;
    const html = `
        <div id="crosscheck-settings" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b class="cc-title"><span class="cc-title-emoji">🔀</span><span>크로스체크</span></b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="cc-actions">
                        <button id="crosscheck-full-scan" type="button" class="menu_button cc-action">검사하기</button>
                        <button id="crosscheck-open-last" type="button" class="menu_button cc-action" disabled>최근 결과</button>
                    </div>
                    <div id="crosscheck-status" class="cc-status">현재 켜진 확장과 등록 CSS만 검사합니다.</div>
                </div>
            </div>
        </div>
    `;
    $("#extensions_settings2").append(html);

    const overlay = document.createElement("div");
    overlay.id = "crosscheck-overlay";
    overlay.innerHTML = `
        <div id="crosscheck-dialog" role="dialog" aria-modal="true" aria-labelledby="crosscheck-dialog-title">
            <div class="cc-dialog-head">
                <div id="crosscheck-dialog-title" class="cc-dialog-title">크로스체크 결과</div>
                <button id="crosscheck-dialog-close" type="button" class="menu_button cc-head-button" aria-label="닫기">×</button>
            </div>
            <div id="crosscheck-dialog-body" class="cc-dialog-body"></div>
            <div class="cc-dialog-foot">
                <button id="crosscheck-copy" type="button" class="menu_button">결과 복사</button>
                <button id="crosscheck-rescan" type="button" class="menu_button">다시 검사</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    enforceDialogLayout(false);

    $("#crosscheck-full-scan").on("click", runFullScan);
    $("#crosscheck-open-last").on("click", () => {
        if (latestReport) renderReport(latestReport);
    });
    $("#crosscheck-dialog-close").on("click", closeReport);
    $("#crosscheck-copy").on("click", copyLatestReport);
    $("#crosscheck-rescan").on("click", runFullScan);
    $("#crosscheck-overlay").on("click", event => {
        if (event.target?.id === "crosscheck-overlay") closeReport();
    });
    const refreshDialogLayout = () => {
        if (document.querySelector("#crosscheck-overlay")?.classList.contains("cc-open")) {
            enforceDialogLayout(true);
        }
    };
    window.addEventListener("resize", refreshDialogLayout, { passive: true });
    window.visualViewport?.addEventListener("resize", refreshDialogLayout, { passive: true });
}

function installErrorMonitor() {
    window.addEventListener("error", event => {
        const message = event.message || event.error?.message || "";
        if (!message || message === "Script error." || message === "알 수 없는 오류") return;
        if (/crosscheck/i.test(event.filename || "") || /크로스체크/.test(message)) return;
        recentErrors.push({
            type: "error",
            time: Date.now(),
            message: shortText(message, 300),
            source: event.filename ? `${event.filename}:${event.lineno || 0}` : "",
            stack: shortText(event.error?.stack || "", 500),
        });
        if (recentErrors.length > MAX_ERRORS) recentErrors.shift();
    }, true);

    window.addEventListener("unhandledrejection", event => {
        const reason = event.reason;
        const message = reason?.message || String(reason || "");
        if (!message || message === "알 수 없는 Promise 오류") return;
        if (/crosscheck/i.test(reason?.stack || "") || /크로스체크/.test(message)) return;
        recentErrors.push({
            type: "promise",
            time: Date.now(),
            message: shortText(message, 300),
            source: "",
            stack: shortText(reason?.stack || "", 500),
        });
        if (recentErrors.length > MAX_ERRORS) recentErrors.shift();
    });
}

function installStyleMonitor() {
    if (styleMutationObserver) return;
    styleMutationObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element) || !node.matches("style, link[rel='stylesheet']")) continue;
                if (node.dataset.crosscheckParser === "true" || node.id === "crosscheck-style") continue;
                recentStyleChanges.push({
                    time: Date.now(),
                    type: node.tagName.toLowerCase(),
                    source: node.getAttribute("href") || node.id || node.dataset.extension || "동적 인라인 CSS",
                });
                if (recentStyleChanges.length > 50) recentStyleChanges.shift();
            }
        }
    });
    styleMutationObserver.observe(document.head, { childList: true });
}

installErrorMonitor();

jQuery(async () => {
    getSettings();
    addUi();
    installStyleMonitor();
});
