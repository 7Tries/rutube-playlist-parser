/**
 * Rutube Playlist Parser - Frontend Application Logic
 * Handles real-time SSE streaming, responsive UI rendering, clipboard actions, and exports.
 */

(function () {
  'use strict';

  // --- State ---
  const state = {
    videos: [],
    metadata: null,
    target: null,
    currentView: 'cards', // 'cards' | 'list' | 'raw'
    searchQuery: '',
    sortBy: 'original',
    selectedIds: new Set(),
    activeEventSource: null,
    isParsing: false,
    optionsOpen: false,
    exportMenuOpen: false,
  };

  // --- DOM Elements ---
  const el = {
    // Inputs & Forms
    urlInput: document.getElementById('urlInput'),
    btnPaste: document.getElementById('btnPaste'),
    btnClear: document.getElementById('btnClear'),
    btnParse: document.getElementById('btnParse'),
    btnCancel: document.getElementById('btnCancel'),
    btnToggleOptions: document.getElementById('btnToggleOptions'),
    optionsDrawer: document.getElementById('optionsDrawer'),
    optMaxPages: document.getElementById('optMaxPages'),
    optUrlFormat: document.getElementById('optUrlFormat'),

    // Samples
    sampleChips: document.querySelectorAll('.sample-chip'),

    // Progress & Errors
    progressSection: document.getElementById('progressSection'),
    progressBar: document.getElementById('progressBar'),
    progressMessage: document.getElementById('progressMessage'),
    progressCounter: document.getElementById('progressCounter'),
    errorSection: document.getElementById('errorSection'),
    errorMessage: document.getElementById('errorMessage'),
    btnDismissError: document.getElementById('btnDismissError'),

    // Results
    resultsSection: document.getElementById('resultsSection'),
    playlistMetaCard: document.getElementById('playlistMetaCard'),
    metaCoverWrap: document.getElementById('metaCoverWrap'),
    metaCover: document.getElementById('metaCover'),
    metaTitle: document.getElementById('metaTitle'),
    metaDesc: document.getElementById('metaDesc'),
    metaTypeBadge: document.getElementById('metaTypeBadge'),
    metaCountBadge: document.getElementById('metaCountBadge'),
    metaViewsBadge: document.getElementById('metaViewsBadge'),
    metaRutubeLink: document.getElementById('metaRutubeLink'),
    metaIdText: document.getElementById('metaIdText'),

    // Toolbar
    filterInput: document.getElementById('filterInput'),
    btnClearFilter: document.getElementById('btnClearFilter'),
    sortSelect: document.getElementById('sortSelect'),
    viewButtons: document.querySelectorAll('.view-btn'),
    btnCopyAll: document.getElementById('btnCopyAll'),
    btnCopyAllText: document.getElementById('btnCopyAllText'),
    btnExportToggle: document.getElementById('btnExportToggle'),
    exportMenu: document.getElementById('exportMenu'),

    // Selection
    selectionBar: document.getElementById('selectionBar'),
    selectAllCheckbox: document.getElementById('selectAllCheckbox'),
    selectedCountText: document.getElementById('selectedCountText'),
    btnCopySelected: document.getElementById('btnCopySelected'),
    btnDeselectAll: document.getElementById('btnDeselectAll'),

    // Views
    cardsView: document.getElementById('cardsView'),
    cardsGrid: document.getElementById('cardsGrid'),
    listView: document.getElementById('listView'),
    listTableBody: document.getElementById('listTableBody'),
    tableHeaderCheck: document.getElementById('tableHeaderCheck'),
    rawView: document.getElementById('rawView'),
    rawTextarea: document.getElementById('rawTextarea'),
    rawLinksCount: document.getElementById('rawLinksCount'),
    btnCopyRaw: document.getElementById('btnCopyRaw'),
    btnDownloadRawTxt: document.getElementById('btnDownloadRawTxt'),
    emptyFilterState: document.getElementById('emptyFilterState'),
    btnResetFilter: document.getElementById('btnResetFilter'),

    // Modal & Toast
    helpModal: document.getElementById('helpModal'),
    btnHelpModal: document.getElementById('btnHelpModal'),
    btnCloseHelp: document.getElementById('btnCloseHelp'),
    btnUnderstand: document.getElementById('btnUnderstand'),
    toast: document.getElementById('toast'),
    toastIcon: document.getElementById('toastIcon'),
    toastMessage: document.getElementById('toastMessage'),
  };

  // --- Helper: Toast Notification ---
  let toastTimer = null;
  function showToast(message, isSuccess = true) {
    if (toastTimer) clearTimeout(toastTimer);
    el.toastIcon.textContent = isSuccess ? '✓' : 'ℹ';
    el.toastMessage.textContent = message;
    el.toast.classList.remove('hidden');

    toastTimer = setTimeout(() => {
      el.toast.classList.add('hidden');
    }, 2800);
  }

  // --- Helper: Copy to Clipboard ---
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (err) {
      console.error('Clipboard copy error:', err);
      return false;
    }
  }

  // --- Format Link based on selected option ---
  function formatLinkItem(video, index, format) {
    switch (format) {
      case 'indexed':
        return `#${index + 1} ${video.url}`;
      case 'title_url':
        return `${video.title} — ${video.url}`;
      case 'markdown':
        return `[${video.title}](${video.url})`;
      case 'raw':
      default:
        return video.url;
    }
  }

  // --- Format Multiple Videos to String ---
  function formatVideosList(videoList, format = 'raw') {
    return videoList.map((v, i) => formatLinkItem(v, i, format)).join('\n');
  }

  // --- UI Update: Input Buttons State ---
  function updateInputButtons() {
    el.btnClear.style.display = el.urlInput.value.trim() ? 'inline-flex' : 'none';
  }

  // --- Start Parsing ---
  function startParsing(urlOverride = null) {
    const rawUrl = (urlOverride || el.urlInput.value).trim();
    if (!rawUrl) {
      showToast('Пожалуйста, введите ссылку на плейлист Rutube', false);
      el.urlInput.focus();
      return;
    }

    if (state.isParsing && state.activeEventSource) {
      state.activeEventSource.close();
    }

    // Reset state
    state.videos = [];
    state.metadata = null;
    state.target = null;
    state.selectedIds.clear();
    state.isParsing = true;
    updateSelectionBar();

    // UI Updates
    hideError();
    el.progressSection.classList.remove('hidden');
    el.resultsSection.classList.add('hidden');
    el.progressBar.style.width = '10%';
    el.progressMessage.textContent = 'Подключение к Rutube...';
    el.progressCounter.textContent = '0 видео';

    const btnSpinner = el.btnParse.querySelector('.btn-spinner');
    const btnText = el.btnParse.querySelector('.btn-text');
    if (btnSpinner) btnSpinner.classList.remove('hidden');
    if (btnText) btnText.textContent = 'Парсинг...';
    el.btnParse.disabled = true;

    // Build URL with query params
    const maxPages = parseInt(el.optMaxPages.value, 10) || 0;
    let sseUrl = `/api/stream?url=${encodeURIComponent(rawUrl)}`;
    if (maxPages > 0) {
      sseUrl += `&max_pages=${maxPages}`;
    }

    const eventSource = new EventSource(sseUrl);
    state.activeEventSource = eventSource;

    eventSource.onmessage = function (e) {
      try {
        const payload = JSON.parse(e.data);
        handleStreamPayload(payload);
      } catch (err) {
        console.error('Failed to parse SSE payload:', err, e.data);
      }
    };

    eventSource.onerror = function (e) {
      console.warn('SSE connection closed or error:', e);
      if (state.isParsing) {
        if (state.videos.length > 0) {
          // If we got at least some videos before error, finalize
          finalizeParsing();
          showToast(`Парсинг завершен (получено ${state.videos.length} видео)`);
        } else {
          showError('Не удалось загрузить видео из плейлиста. Проверьте правильность ссылки.');
          stopParsingUI();
        }
      }
      if (state.activeEventSource) {
        state.activeEventSource.close();
        state.activeEventSource = null;
      }
    };
  }

  // --- Handle SSE Events ---
  function handleStreamPayload(data) {
    switch (data.type) {
      case 'status':
        el.progressMessage.textContent = data.message;
        break;

      case 'progress':
        el.progressMessage.textContent = data.message;
        break;

      case 'meta':
        state.metadata = data.metadata;
        state.target = data.target;
        renderMetadataCard(data.metadata, data.target);
        el.resultsSection.classList.remove('hidden');
        break;

      case 'page':
        if (data.videos && data.videos.length > 0) {
          // Append videos
          data.videos.forEach(v => {
            if (!state.videos.some(existing => existing.id === v.id)) {
              state.videos.push(v);
            }
          });

          // Update progress
          el.progressCounter.textContent = `${state.videos.length} видео`;
          if (data.total_pages) {
            const pct = Math.min(95, Math.round((data.page / data.total_pages) * 95));
            el.progressBar.style.width = `${pct}%`;
            el.progressMessage.textContent = `Загружена страница ${data.page} из ${data.total_pages} (${state.videos.length} видео)`;
          } else {
            el.progressBar.style.width = '75%';
            el.progressMessage.textContent = `Загружена страница ${data.page} (${state.videos.length} видео)`;
          }

          // Render live videos
          el.resultsSection.classList.remove('hidden');
          renderCurrentView();
        }
        break;

      case 'complete':
        finalizeParsing();
        showToast(`Успешно спарсено ${data.total} видео!`);
        break;

      case 'error':
        showError(data.message || 'Произошла ошибка при парсинге плейлиста');
        stopParsingUI();
        if (state.activeEventSource) {
          state.activeEventSource.close();
          state.activeEventSource = null;
        }
        break;
    }
  }

  // --- Finalize Parsing ---
  function finalizeParsing() {
    state.isParsing = false;
    el.progressBar.style.width = '100%';
    el.progressMessage.textContent = `Готово! Всего видео: ${state.videos.length}`;

    setTimeout(() => {
      el.progressSection.classList.add('hidden');
    }, 1200);

    stopParsingUI();
    renderCurrentView();

    if (state.activeEventSource) {
      state.activeEventSource.close();
      state.activeEventSource = null;
    }
  }

  function stopParsingUI() {
    state.isParsing = false;
    const btnSpinner = el.btnParse.querySelector('.btn-spinner');
    const btnText = el.btnParse.querySelector('.btn-text');
    if (btnSpinner) btnSpinner.classList.add('hidden');
    if (btnText) btnText.textContent = 'Спарсить ссылки';
    el.btnParse.disabled = false;
  }

  function cancelParsing() {
    if (state.activeEventSource) {
      state.activeEventSource.close();
      state.activeEventSource = null;
    }
    stopParsingUI();
    el.progressSection.classList.add('hidden');
    if (state.videos.length > 0) {
      showToast(`Парсинг остановлен. Сохранено ${state.videos.length} видео.`);
      renderCurrentView();
    } else {
      showToast('Парсинг отменен');
    }
  }

  function showError(msg) {
    el.errorMessage.textContent = msg;
    el.errorSection.classList.remove('hidden');
  }

  function hideError() {
    el.errorSection.classList.add('hidden');
  }

  // --- Render Metadata Header ---
  function renderMetadataCard(meta, target) {
    if (!meta) return;

    el.metaTitle.textContent = meta.title || `Плейлист #${meta.id}`;
    el.metaDesc.textContent = meta.description || 'Описание отсутствует';
    el.metaDesc.style.display = meta.description ? 'block' : 'none';

    el.metaIdText.textContent = `ID: ${meta.id}`;
    el.metaRutubeLink.href = meta.clean_url || `https://rutube.ru/plst/${meta.id}/`;

    if (target && target.type === 'channel') {
      el.metaTypeBadge.textContent = 'Канал';
      el.metaTypeBadge.className = 'badge-pastel badge-sage';
    } else {
      el.metaTypeBadge.textContent = 'Плейлист';
      el.metaTypeBadge.className = 'badge-pastel badge-lilac';
    }

    const count = meta.videos_count !== null ? meta.videos_count : state.videos.length;
    el.metaCountBadge.textContent = `${count} видео`;

    if (meta.total_views) {
      el.metaViewsBadge.style.display = 'inline-block';
      el.metaViewsBadge.textContent = `${Number(meta.total_views).toLocaleString('ru-RU')} просмотров`;
    } else {
      el.metaViewsBadge.style.display = 'none';
    }

    if (meta.thumbnail_url) {
      el.metaCover.src = meta.thumbnail_url;
      el.metaCoverWrap.style.display = 'flex';
    } else if (state.videos.length > 0 && state.videos[0].thumbnail) {
      el.metaCover.src = state.videos[0].thumbnail;
      el.metaCoverWrap.style.display = 'flex';
    } else {
      el.metaCoverWrap.style.display = 'none';
    }
  }

  // --- Filter and Sort Videos ---
  function getFilteredAndSortedVideos() {
    let result = [...state.videos];

    // Filter by title / author / url
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      result = result.filter(v => 
        (v.title && v.title.toLowerCase().includes(q)) ||
        (v.author_name && v.author_name.toLowerCase().includes(q)) ||
        (v.url && v.url.toLowerCase().includes(q))
      );
    }

    // Sort
    switch (state.sortBy) {
      case 'title_asc':
        result.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
        break;
      case 'title_desc':
        result.sort((a, b) => b.title.localeCompare(a.title, 'ru'));
        break;
      case 'duration_desc':
        result.sort((a, b) => (b.duration || 0) - (a.duration || 0));
        break;
      case 'duration_asc':
        result.sort((a, b) => (a.duration || 0) - (b.duration || 0));
        break;
      case 'original':
      default:
        // Original order as received
        break;
    }

    return result;
  }

  // --- Render Current View ---
  function renderCurrentView() {
    const filteredVideos = getFilteredAndSortedVideos();

    // Empty state
    if (filteredVideos.length === 0 && state.videos.length > 0) {
      el.emptyFilterState.classList.remove('hidden');
      el.cardsGrid.innerHTML = '';
      el.listTableBody.innerHTML = '';
      el.rawTextarea.value = '';
      return;
    } else {
      el.emptyFilterState.classList.add('hidden');
    }

    // Render depending on active view
    if (state.currentView === 'cards') {
      renderCardsView(filteredVideos);
    } else if (state.currentView === 'list') {
      renderListView(filteredVideos);
    } else if (state.currentView === 'raw') {
      renderRawView(filteredVideos);
    }

    // Always update Raw Textarea count & preview
    const format = el.optUrlFormat.value || 'raw';
    el.rawTextarea.value = formatVideosList(filteredVideos, format);
    el.rawLinksCount.textContent = filteredVideos.length;

    updateSelectionBar();
  }

  // --- Render Cards View ---
  function renderCardsView(videos) {
    el.cardsGrid.innerHTML = '';
    const fragment = document.createDocumentFragment();

    videos.forEach((video, index) => {
      const isSelected = state.selectedIds.has(video.id);
      const card = document.createElement('div');
      card.className = `video-card ${isSelected ? 'selected' : ''}`;
      card.dataset.id = video.id;

      const thumbUrl = video.thumbnail || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9" fill="%23e8e2d8"></svg>';

      card.innerHTML = `
        <div class="card-thumb-wrap">
          <img class="card-thumb" src="${thumbUrl}" alt="" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 9%22 fill=%22%23e8e2d8%22></svg>'">
          <span class="card-index">#${index + 1}</span>
          <span class="card-duration">${video.duration_formatted || '--:--'}</span>
          <div class="card-select-wrap">
            <input type="checkbox" class="checkbox-soft card-checkbox" ${isSelected ? 'checked' : ''} data-id="${video.id}">
          </div>
        </div>
        <div class="card-content">
          <h3 class="card-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</h3>
          <div class="card-author-row">
            ${video.author_avatar ? `<img class="author-avatar" src="${video.author_avatar}" alt="">` : ''}
            <span>${escapeHtml(video.author_name || 'Rutube')}</span>
          </div>
          <div class="card-url-pill" title="Нажмите, чтобы скопировать ссылку" data-url="${video.url}">
            ${video.url}
          </div>
          <div class="card-footer">
            <button type="button" class="btn-card-copy" data-url="${video.url}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Копировать</span>
            </button>
            <a href="${video.url}" target="_blank" rel="noopener noreferrer" class="btn-card-open" title="Открыть видео на Rutube">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>
          </div>
        </div>
      `;

      fragment.appendChild(card);
    });

    el.cardsGrid.appendChild(fragment);
  }

  // --- Render List View ---
  function renderListView(videos) {
    el.listTableBody.innerHTML = '';
    const fragment = document.createDocumentFragment();

    videos.forEach((video, index) => {
      const isSelected = state.selectedIds.has(video.id);
      const tr = document.createElement('tr');
      tr.className = isSelected ? 'row-selected' : '';

      const thumbUrl = video.thumbnail || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9" fill="%23e8e2d8"></svg>';

      tr.innerHTML = `
        <td>
          <input type="checkbox" class="checkbox-soft list-checkbox" ${isSelected ? 'checked' : ''} data-id="${video.id}">
        </td>
        <td><strong>${index + 1}</strong></td>
        <td>
          <img class="table-thumb" src="${thumbUrl}" alt="" loading="lazy">
        </td>
        <td class="table-title">
          <div title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</div>
        </td>
        <td><span class="badge-pastel badge-lilac">${video.duration_formatted || '--:--'}</span></td>
        <td>${escapeHtml(video.author_name || 'Rutube')}</td>
        <td>
          <a href="${video.url}" target="_blank" rel="noopener noreferrer" class="table-link">${video.url}</a>
        </td>
        <td>
          <div class="table-actions">
            <button type="button" class="btn-subtle" data-url="${video.url}" title="Скопировать ссылку">
              📋
            </button>
            <a href="${video.url}" target="_blank" rel="noopener noreferrer" class="btn-subtle" title="Открыть видео">
              ↗
            </a>
          </div>
        </td>
      `;

      fragment.appendChild(tr);
    });

    el.listTableBody.appendChild(fragment);
  }

  // --- Render Raw View ---
  function renderRawView(videos) {
    const format = el.optUrlFormat.value || 'raw';
    el.rawTextarea.value = formatVideosList(videos, format);
  }

  // --- Selection Logic ---
  function toggleSelectId(id) {
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
    } else {
      state.selectedIds.add(id);
    }
    updateSelectionBar();
  }

  function updateSelectionBar() {
    const total = state.videos.length;
    const count = state.selectedIds.size;

    if (count > 0) {
      el.selectionBar.classList.remove('hidden');
      el.selectedCountText.textContent = `Выбрано: ${count} из ${total}`;
      el.selectAllCheckbox.checked = count === total;
      if (el.tableHeaderCheck) el.tableHeaderCheck.checked = count === total;
    } else {
      el.selectionBar.classList.add('hidden');
      el.selectAllCheckbox.checked = false;
      if (el.tableHeaderCheck) el.tableHeaderCheck.checked = false;
    }
  }

  function selectAll() {
    const filtered = getFilteredAndSortedVideos();
    if (state.selectedIds.size === filtered.length) {
      state.selectedIds.clear();
    } else {
      filtered.forEach(v => state.selectedIds.add(v.id));
    }
    renderCurrentView();
  }

  function deselectAll() {
    state.selectedIds.clear();
    renderCurrentView();
  }

  // --- Export Features ---
  function downloadFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Файл ${fileName} успешно сохранен`);
  }

  function exportData(type) {
    const videos = state.selectedIds.size > 0 
      ? state.videos.filter(v => state.selectedIds.has(v.id))
      : getFilteredAndSortedVideos();

    if (videos.length === 0) {
      showToast('Нет видео для экспорта', false);
      return;
    }

    const playlistName = (state.metadata && state.metadata.title) ? state.metadata.title.replace(/[\\/:*?"<>|]/g, '_') : 'rutube_playlist';
    const timestamp = new Date().toISOString().slice(0, 10);

    switch (type) {
      case 'txt': {
        const format = el.optUrlFormat.value || 'raw';
        const txt = formatVideosList(videos, format);
        downloadFile(txt, `${playlistName}_links_${timestamp}.txt`, 'text/plain;charset=utf-8');
        break;
      }
      case 'csv': {
        // UTF-8 BOM for Excel compatibility with Cyrillic characters
        let csv = '\uFEFF"№","Название","Ссылка","Длительность","Секунды","Автор","Просмотры","ID"\n';
        videos.forEach((v, i) => {
          const title = (v.title || '').replace(/"/g, '""');
          const author = (v.author_name || '').replace(/"/g, '""');
          csv += `"${i + 1}","${title}","${v.url}","${v.duration_formatted}","${v.duration || 0}","${author}","${v.views || 0}","${v.id}"\n`;
        });
        downloadFile(csv, `${playlistName}_${timestamp}.csv`, 'text/csv;charset=utf-8');
        break;
      }
      case 'json': {
        const jsonData = JSON.stringify({
          playlist: state.metadata,
          total: videos.length,
          exported_at: new Date().toISOString(),
          videos: videos
        }, null, 2);
        downloadFile(jsonData, `${playlistName}_${timestamp}.json`, 'application/json;charset=utf-8');
        break;
      }
      case 'md': {
        let md = `# ${state.metadata ? state.metadata.title : 'Rutube Playlist'}\n\n`;
        if (state.metadata && state.metadata.clean_url) {
          md += `> Плейлист Rutube: ${state.metadata.clean_url}\n\n`;
        }
        md += `Всего видео: ${videos.length}\n\n`;
        videos.forEach((v, i) => {
          md += `${i + 1}. [${v.title}](${v.url}) — \`${v.duration_formatted}\` (${v.author_name})\n`;
        });
        downloadFile(md, `${playlistName}_${timestamp}.md`, 'text/markdown;charset=utf-8');
        break;
      }
    }

    el.exportMenu.classList.add('hidden');
    state.exportMenuOpen = false;
  }

  // --- Utility: Escape HTML ---
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- Attach Event Listeners ---
  function setupEvents() {
    // Input events
    el.urlInput.addEventListener('input', updateInputButtons);
    el.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        startParsing();
      }
    });

    el.btnClear.addEventListener('click', () => {
      el.urlInput.value = '';
      updateInputButtons();
      el.urlInput.focus();
    });

    el.btnPaste.addEventListener('click', async () => {
      try {
        if (navigator.clipboard) {
          const text = await navigator.clipboard.readText();
          if (text) {
            el.urlInput.value = text.trim();
            updateInputButtons();
            showToast('Ссылка вставлена из буфера');
          }
        } else {
          showToast('Доступ к буферу обмена заблокирован', false);
        }
      } catch (err) {
        showToast('Разрешите доступ к буферу обмена в браузере', false);
      }
    });

    el.btnParse.addEventListener('click', () => startParsing());
    el.btnCancel.addEventListener('click', cancelParsing);

    // Options toggle
    el.btnToggleOptions.addEventListener('click', () => {
      state.optionsOpen = !state.optionsOpen;
      el.optionsDrawer.classList.toggle('hidden', !state.optionsOpen);
    });

    el.optUrlFormat.addEventListener('change', () => {
      renderCurrentView();
    });

    // Sample chips
    el.sampleChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const url = chip.dataset.url;
        el.urlInput.value = url;
        updateInputButtons();
        startParsing(url);
      });
    });

    // Dismiss Error
    el.btnDismissError.addEventListener('click', hideError);

    // Filter Search
    el.filterInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim();
      el.btnClearFilter.classList.toggle('hidden', !state.searchQuery);
      renderCurrentView();
    });

    el.btnClearFilter.addEventListener('click', () => {
      el.filterInput.value = '';
      state.searchQuery = '';
      el.btnClearFilter.classList.add('hidden');
      renderCurrentView();
    });

    el.btnResetFilter.addEventListener('click', () => {
      el.filterInput.value = '';
      state.searchQuery = '';
      el.btnClearFilter.classList.add('hidden');
      renderCurrentView();
    });

    // Sort
    el.sortSelect.addEventListener('change', (e) => {
      state.sortBy = e.target.value;
      renderCurrentView();
    });

    // View buttons
    el.viewButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        el.viewButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        state.currentView = btn.dataset.view;
        el.cardsView.classList.toggle('active', state.currentView === 'cards');
        el.listView.classList.toggle('active', state.currentView === 'list');
        el.rawView.classList.toggle('active', state.currentView === 'raw');

        renderCurrentView();
      });
    });

    // Copy All Links
    el.btnCopyAll.addEventListener('click', async () => {
      const videos = getFilteredAndSortedVideos();
      if (videos.length === 0) return;

      const format = el.optUrlFormat.value || 'raw';
      const text = formatVideosList(videos, format);
      const success = await copyText(text);

      if (success) {
        showToast(`Скопировано ${videos.length} ссылок в буфер!`);
        el.btnCopyAllText.textContent = 'Скопировано! ✓';
        setTimeout(() => {
          el.btnCopyAllText.textContent = 'Скопировать все ссылки';
        }, 2000);
      }
    });

    // Copy Selected Links
    el.btnCopySelected.addEventListener('click', async () => {
      const selectedVideos = state.videos.filter(v => state.selectedIds.has(v.id));
      if (selectedVideos.length === 0) return;

      const format = el.optUrlFormat.value || 'raw';
      const text = formatVideosList(selectedVideos, format);
      const success = await copyText(text);

      if (success) {
        showToast(`Скопировано ${selectedVideos.length} выбранных ссылок!`);
      }
    });

    el.btnDeselectAll.addEventListener('click', deselectAll);
    el.selectAllCheckbox.addEventListener('change', selectAll);
    if (el.tableHeaderCheck) {
      el.tableHeaderCheck.addEventListener('change', selectAll);
    }

    // Export Dropdown
    el.btnExportToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      state.exportMenuOpen = !state.exportMenuOpen;
      el.exportMenu.classList.toggle('hidden', !state.exportMenuOpen);
    });

    document.querySelectorAll('.dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        const type = item.dataset.export;
        exportData(type);
      });
    });

    document.addEventListener('click', (e) => {
      if (state.exportMenuOpen && !el.btnExportToggle.contains(e.target) && !el.exportMenu.contains(e.target)) {
        state.exportMenuOpen = false;
        el.exportMenu.classList.add('hidden');
      }
    });

    // Delegated click events for cards & table (copy individual url, checkbox select)
    document.addEventListener('click', async (e) => {
      // Individual copy button
      const copyBtn = e.target.closest('.btn-card-copy, .table-actions .btn-subtle, .card-url-pill');
      if (copyBtn && copyBtn.dataset.url) {
        e.stopPropagation();
        const url = copyBtn.dataset.url;
        await copyText(url);
        showToast('Ссылка скопирована!');
        return;
      }

      // Checkbox click in card
      const cb = e.target.closest('.card-checkbox, .list-checkbox');
      if (cb && cb.dataset.id) {
        toggleSelectId(cb.dataset.id);
        const card = cb.closest('.video-card');
        if (card) {
          card.classList.toggle('selected', state.selectedIds.has(cb.dataset.id));
        }
        const row = cb.closest('tr');
        if (row) {
          row.classList.toggle('row-selected', state.selectedIds.has(cb.dataset.id));
        }
      }
    });

    // Raw View Actions
    el.btnCopyRaw.addEventListener('click', async () => {
      if (el.rawTextarea.value) {
        await copyText(el.rawTextarea.value);
        showToast('Текст ссылок скопирован!');
      }
    });

    el.btnDownloadRawTxt.addEventListener('click', () => {
      exportData('txt');
    });

    // Help Modal
    el.btnHelpModal.addEventListener('click', () => {
      el.helpModal.classList.remove('hidden');
    });

    el.btnCloseHelp.addEventListener('click', () => {
      el.helpModal.classList.add('hidden');
    });

    el.btnUnderstand.addEventListener('click', () => {
      el.helpModal.classList.add('hidden');
    });

    el.helpModal.addEventListener('click', (e) => {
      if (e.target === el.helpModal) {
        el.helpModal.classList.add('hidden');
      }
    });
  }

  // --- Initialize App ---
  document.addEventListener('DOMContentLoaded', () => {
    setupEvents();
    updateInputButtons();
  });

})();
