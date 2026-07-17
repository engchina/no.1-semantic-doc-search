import { expect, test } from '@playwright/test';

const objectResponse = {
  success: true,
  objects: [{
    name: 'catalog.pdf', size: 1024, time_created: '2026-07-15T00:00:00Z',
    page_images: {
      release_id: 'draft-1', release_status: 'DRAFT', revision_id: 'revision-1',
      count: 2, stage_status: 'SUCCEEDED'
    },
    processing: {
      document_id: 'doc-1', publication_status: 'UPDATE_AVAILABLE',
      serving_release_id: 'release-1', draft_release_id: 'draft-1', stages: {},
      page_images: {
        selector: 'serving',
        selected: { release_id: 'release-1', release_status: 'PUBLISHED', revision_id: 'revision-1', count: 1, stage_status: 'SUCCEEDED' },
        draft: { release_id: 'draft-1', release_status: 'DRAFT', revision_id: 'revision-1', count: 2, stage_status: 'SUCCEEDED' },
        serving: { release_id: 'release-1', release_status: 'PUBLISHED', revision_id: 'revision-1', count: 1, stage_status: 'SUCCEEDED' }
      }
    }
  }],
  pagination: { current_page: 1, page_size: 20, total: 1, total_pages: 1, start_row: 1, end_row: 1 },
  statistics: { file_count: 1, page_image_count: 2, total_count: 3 }
};

const pageImageResponse = {
  document_id: 'doc-1', object_name: 'catalog.pdf', revision_id: 'revision-1',
  release_id: 'draft-1', release_status: 'DRAFT', stage_status: 'SUCCEEDED', total: 2,
  items: [1, 2].map(pageNumber => ({
    artifact_id: `artifact-${pageNumber}`, page_number: pageNumber,
    media_type: 'image/png', size: 128, content_sha256: 'a'.repeat(64),
    created_at: '2026-07-15T00:01:00Z', stage_status: 'SUCCEEDED'
  })),
  pagination: { current_page: 1, page_size: 50, total: 2, total_pages: 1, has_next: false, has_prev: false }
};

async function mockBaseApis(page, {
  objects = objectResponse,
  pageImages = () => pageImageResponse
} = {}) {
  await page.route('**/ai/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/config')) {
      return route.fulfill({ json: { require_login: false, show_ai_assistant: false } });
    }
    if (url.pathname.endsWith('/auth/status')) {
      return route.fulfill({ json: { authenticated: true, username: 'admin' } });
    }
    if (url.pathname.endsWith('/oci/objects')) {
      return route.fulfill({ json: objects });
    }
    if (/\/documents\/[^/]+\/page-images$/.test(url.pathname)) {
      return route.fulfill({ json: pageImages(url) });
    }
    if (url.pathname.includes('/page-images/') && url.pathname.endsWith('/content')) {
      return route.fulfill({
        status: 200, contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
      });
    }
    return route.fulfill({ json: { success: true, profiles: [], documents: [] } });
  });
}

test('文書処理メニューをキーボードで操作できる', async ({ page }) => {
  await mockBaseApis(page);
  await page.goto('/');
  await page.getByRole('tab', { name: /文書管理/ }).click();
  await page.evaluate(() => window.ociModule.loadOciObjects(false));
  await expect(page.getByRole('button', { name: /処理タスク$/ })).toBeEnabled();
  await page.locator('#documentsList tbody input[type="checkbox"]').first().check();

  await expect(page.getByRole('button', { name: /すべて処理 \(1件\)/ })).toBeEnabled();
  const menuButton = page.getByRole('button', { name: /処理段階を選択/ });
  await menuButton.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();

  const menuItems = menu.getByRole('menuitem');
  await expect(menuItems).toHaveCount(5);
  const itemStyles = await menuItems.evaluateAll(items => items.map(item => {
    const label = item.querySelector('span');
    const helper = item.querySelector('small');
    const itemStyle = getComputedStyle(item);
    const labelStyle = getComputedStyle(label);
    const helperStyle = getComputedStyle(helper);
    return {
      display: itemStyle.display,
      width: itemStyle.width,
      minHeight: itemStyle.minHeight,
      padding: itemStyle.padding,
      fontSize: labelStyle.fontSize,
      labelDisplay: labelStyle.display,
      flexDirection: labelStyle.flexDirection,
      helperDisplay: helperStyle.display,
      helperFontSize: helperStyle.fontSize
    };
  }));
  expect(new Set(itemStyles.map(style => JSON.stringify(style))).size).toBe(1);
  expect(itemStyles[0]).toMatchObject({
    display: 'flex',
    minHeight: '44px',
    labelDisplay: 'flex',
    flexDirection: 'column',
    helperDisplay: 'block',
    helperFontSize: '11px'
  });

  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: /検索へ反映/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menuButton).toBeFocused();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
});

test('下に空間がないときは処理段階メニューが上向きに開く', async ({ page }) => {
  await mockBaseApis(page);
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto('/');
  await page.getByRole('tab', { name: /文書管理/ }).click();
  await page.evaluate(() => window.ociModule.loadOciObjects(false));
  await page.locator('#documentsList tbody input[type="checkbox"]').first().check();

  const menuButton = page.getByRole('button', { name: /処理段階を選択/ });
  await menuButton.evaluate(el => el.scrollIntoView({ block: 'end' }));
  await menuButton.click();
  const menu = page.locator('#pipelineStageMenu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveClass(/drop-up/);
  const menuBox = await menu.boundingBox();
  const buttonBox = await menuButton.boundingBox();
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(buttonBox.y);
});

test('ページ画像はArtifact子行として表示し選択対象にしない', async ({ page }) => {
  await mockBaseApis(page);
  await page.goto('/');
  await page.getByRole('tab', { name: /文書管理/ }).click();
  await page.evaluate(() => window.ociModule.loadOciObjects(false));

  await page.getByRole('button', { name: 'ファイル＋ページ画像' }).click();
  const releaseGroup = page.getByRole('group', { name: '表示するページ画像の版' });
  await expect(releaseGroup).toBeVisible();
  await expect(releaseGroup.getByRole('button')).toHaveCount(2);
  await expect(releaseGroup.getByRole('button', { name: 'Draft', exact: true })).toBeVisible();
  await expect(releaseGroup.getByRole('button', { name: '公開済み', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(releaseGroup.getByRole('button', { name: '最新', exact: true })).toHaveCount(0);
  await expect(page.getByText('ページ画像: 2件')).toBeVisible();
  await page.getByRole('button', { name: /catalog\.pdfのページ画像を開く/ }).click();

  await expect(page.locator('.page-image-child-row')).toHaveCount(2);
  await expect(page.locator('.page-image-child-row input[type="checkbox"]')).toHaveCount(0);
  await expect(page.getByText('ページ 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'すべて選択' }).click();
  await expect(page.getByRole('button', { name: /すべて処理 \(1件\)/ })).toBeEnabled();

  await page.getByRole('button', { name: 'ページ 1をプレビュー' }).click();
  const preview = page.getByRole('dialog', { name: 'ページ画像プレビュー' });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('group', { name: '表示するページ画像の版' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'プレビューを閉じる' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#imageModalFilename')).toHaveText('ページ 2');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'ページ画像プレビュー' })).toHaveCount(0);
});

test('ページ画像の展開と追加読込はクリック位置を保持する', async ({ page }, testInfo) => {
  const objects = {
    ...objectResponse,
    objects: Array.from({ length: 20 }, (_, index) => ({
      ...objectResponse.objects[0],
      name: `file-${index + 1}.pdf`,
      page_images: { ...objectResponse.objects[0].page_images, count: 84 },
      processing: {
        ...objectResponse.objects[0].processing,
        document_id: `doc-${index + 1}`
      }
    })),
    pagination: {
      current_page: 1, page_size: 20, total: 20, total_pages: 1,
      start_row: 1, end_row: 20
    },
    statistics: { file_count: 20, page_image_count: 1680, total_count: 1700 }
  };
  const pageItems = (start, end) => Array.from(
    { length: end - start + 1 },
    (_, index) => {
      const pageNumber = start + index;
      return {
        artifact_id: `artifact-${pageNumber}`,
        page_number: pageNumber,
        media_type: 'image/png',
        size: 128,
        content_sha256: 'a'.repeat(64),
        created_at: '2026-07-15T00:01:00Z',
        stage_status: 'SUCCEEDED'
      };
    }
  );
  await mockBaseApis(page, {
    objects,
    pageImages: url => {
      const currentPage = Number(url.searchParams.get('page') || 1);
      return {
        ...pageImageResponse,
        document_id: url.pathname.split('/').at(-2),
        release_id: 'release-1',
        total: 84,
        items: currentPage === 1 ? pageItems(1, 50) : pageItems(51, 84),
        pagination: {
          current_page: currentPage,
          page_size: 50,
          total: 84,
          total_pages: 2,
          has_next: currentPage === 1,
          has_prev: currentPage > 1
        }
      };
    }
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /文書管理/ }).click();
  await page.evaluate(() => window.ociModule.loadOciObjects(false));
  await page.getByRole('button', { name: 'ファイル＋ページ画像' }).click();

  const expandButton = page.getByRole('button', { name: /file-13\.pdfのページ画像を開く/ });
  await expandButton.scrollIntoViewIfNeeded();
  const beforeExpand = await expandButton.evaluate(button => {
    const tableScroller = button.closest('.table-wrapper-scrollable');
    const tabScroller = document.querySelector('.tab-scroll-container');
    return {
      top: button.getBoundingClientRect().top,
      tableScrollTop: tableScroller.scrollTop,
      tabScrollTop: tabScroller.scrollTop
    };
  });
  await expandButton.click();
  await expect(page.locator('.page-image-child-row[data-document-id="doc-13"]')).toHaveCount(50);
  const expandedButton = page.getByRole('button', { name: /file-13\.pdfのページ画像を閉じる/ });
  const afterExpand = await expandedButton.evaluate(button => {
    const tableScroller = button.closest('.table-wrapper-scrollable');
    const tabScroller = document.querySelector('.tab-scroll-container');
    return {
      top: button.getBoundingClientRect().top,
      tableScrollTop: tableScroller.scrollTop,
      tabScrollTop: tabScroller.scrollTop
    };
  });
  expect(afterExpand.tableScrollTop).toBe(beforeExpand.tableScrollTop);
  expect(afterExpand.tabScrollTop).toBe(beforeExpand.tabScrollTop);
  expect(Math.abs(afterExpand.top - beforeExpand.top)).toBeLessThanOrEqual(1);
  await expect(expandedButton).toBeFocused();

  const loadMoreButton = page.getByRole('button', { name: /さらに表示/ });
  await loadMoreButton.scrollIntoViewIfNeeded();
  const beforeLoadMore = await loadMoreButton.evaluate(button => {
    const tableScroller = button.closest('.table-wrapper-scrollable');
    const tabScroller = document.querySelector('.tab-scroll-container');
    return {
      top: button.closest('tr').getBoundingClientRect().top,
      tableScrollTop: tableScroller.scrollTop,
      tabScrollTop: tabScroller.scrollTop
    };
  });
  await loadMoreButton.click();
  await expect(page.locator('.page-image-child-row[data-document-id="doc-13"]')).toHaveCount(84);
  const page51Button = page.getByRole('button', { name: 'ページ 51をプレビュー' });
  const afterLoadMore = await page51Button.evaluate(button => {
    const tableScroller = button.closest('.table-wrapper-scrollable');
    const tabScroller = document.querySelector('.tab-scroll-container');
    return {
      top: button.closest('tr').getBoundingClientRect().top,
      tableScrollTop: tableScroller.scrollTop,
      tabScrollTop: tabScroller.scrollTop
    };
  });
  expect(afterLoadMore.tableScrollTop).toBe(beforeLoadMore.tableScrollTop);
  expect(afterLoadMore.tabScrollTop).toBe(beforeLoadMore.tabScrollTop);
  expect(Math.abs(afterLoadMore.top - beforeLoadMore.top)).toBeLessThanOrEqual(1);
  await expect(page51Button).toBeFocused();

  if (testInfo.project.name === 'mobile-375px') {
    await page.setViewportSize({ width: 812, height: 375 });
    await expect(page.locator('#documentsList .table-wrapper-scrollable')).toBeVisible();
    const hasPageOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(hasPageOverflow).toBe(false);
  }
});

test('すべて処理は全段階を強制再実行するFULL Jobを送信する', async ({ page }) => {
  let createdRequest;
  await mockBaseApis(page);
  await page.route('**/ai/api/pipeline/jobs/preview', async route => route.fulfill({ json: {
    object_count: 1,
    requested_steps: [
      'render', 'native_parse', 'normalize',
      'vlm:1', 'vlm:2', 'vlm:3',
      'embedding:vlm_text_slot_1', 'embedding:vlm_text_slot_2',
      'embedding:vlm_text_slot_3', 'publish'
    ],
    prerequisite_steps: [], downstream_steps: [], estimated_oci_calls: 6,
    estimated_pages: 1, publish_mode: 'AUTO', can_publish_automatically: true,
    warnings: []
  } }));
  await page.route('**/ai/api/pipeline/jobs', async route => {
    createdRequest = route.request().postDataJSON();
    return route.fulfill({ json: { job_id: 'full-job', status: 'QUEUED' } });
  });

  await page.goto('/');
  await page.getByRole('tab', { name: /文書管理/ }).click();
  await page.evaluate(() => window.ociModule.loadOciObjects(false));
  await page.locator('#documentsList tbody input[type="checkbox"]').check();
  await page.getByRole('button', { name: /すべて処理 \(1件\)/ }).click();
  await expect(page.locator('#global-confirm-modal-content')).toContainText('完了後に自動公開');
  await page.getByRole('button', { name: '実行', exact: true }).click();

  await expect.poll(() => createdRequest).toBeTruthy();
  expect(createdRequest).toMatchObject({
    object_names: ['catalog.pdf'], mode: 'FULL', steps: [], force: true,
    include_downstream: false, publish_mode: 'AUTO'
  });
});

test('ページ画像の再生成はRENDERだけをDraft Jobとして送信する', async ({ page }) => {
  let createdRequest;
  await mockBaseApis(page);
  await page.route('**/ai/api/pipeline/jobs/preview', async route => route.fulfill({ json: {
    object_count: 1, requested_steps: ['render'], prerequisite_steps: [],
    downstream_steps: ['normalize', 'ocr', 'vlm:1'], estimated_oci_calls: 0,
    estimated_pages: 12, publish_mode: 'DRAFT', can_publish_automatically: false, warnings: []
  } }));
  await page.route('**/ai/api/pipeline/jobs', async route => {
    createdRequest = route.request().postDataJSON();
    return route.fulfill({ json: { job_id: 'render-job', status: 'QUEUED' } });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /文書管理/ }).click();
  await page.evaluate(() => window.ociModule.loadOciObjects(false));
  await page.locator('#documentsList tbody input[type="checkbox"]').check();
  await page.getByRole('button', { name: /処理段階を選択/ }).click();
  await page.getByRole('menuitem', { name: /ページ画像を再生成/ }).click();
  await expect(page.locator('#global-confirm-modal-content')).toContainText('Draftに保存');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await expect.poll(() => createdRequest).toBeTruthy();
  expect(createdRequest).toMatchObject({
    mode: 'CUSTOM', steps: [{ kind: 'RENDER' }], force: true,
    include_downstream: false, publish_mode: 'DRAFT'
  });
});

test('Draft公開の検証失敗は不足した段階を表示する', async ({ page }) => {
  await mockBaseApis(page);
  await page.route('**/documents/doc-1/releases/draft-1/publish', async route => {
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        detail: 'Releaseの構成が不完全なため公開できません（未実行: vlm:1, embedding:vlm_text_slot_1）'
      })
    });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /文書管理/ }).click();
  await page.evaluate(() => window.ociModule.loadOciObjects(false));
  await page.locator('#documentsList tbody input[type="checkbox"]').check();
  await page.getByRole('button', { name: /処理段階を選択/ }).click();
  await page.getByRole('menuitem', { name: /検索へ反映/ }).click();
  await page.getByRole('button', { name: '検証して公開' }).click();

  await expect(page.getByText(/未実行: vlm:1, embedding:vlm_text_slot_1/)).toBeVisible();
});

test('一時的な状態取得失敗をJob失敗にせず再接続表示する', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sdsPipelineJobIds', JSON.stringify(['job-transient']));
  });
  await page.route('**/ai/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/config')) {
      return route.fulfill({ json: { require_login: false, show_ai_assistant: false } });
    }
    if (url.pathname.includes('/pipeline/jobs/job-transient')) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'データベースへ再接続中です' })
      });
    }
    return route.fulfill({ json: { success: true, authenticated: true } });
  });

  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('自動的に再接続します');
  await expect(page.locator('.pipeline-job-card')).toHaveAttribute('data-status', 'QUEUED');
  await expect(page.getByRole('button', { name: '今すぐ再試行' })).toBeVisible();
});

test('キャンセル済みタスクは復元後に活動トレイと保存一覧から消える', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sdsPipelineJobIds', JSON.stringify(['job-cancelled']));
  });
  await page.route('**/ai/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/config')) {
      return route.fulfill({ json: { require_login: false, show_ai_assistant: false } });
    }
    if (url.pathname.includes('/pipeline/jobs/job-cancelled')) {
      return route.fulfill({ json: {
        job_id: 'job-cancelled', status: 'CANCELLED', mode: 'FULL',
        publish_mode: 'AUTO', cancel_requested: true, total_steps: 13,
        completed_steps: 0, failed_steps: 0, steps: []
      } });
    }
    return route.fulfill({ json: { success: true, authenticated: true } });
  });

  await page.goto('/');

  await expect(page.locator('#pipelineJobTray')).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sdsPipelineJobIds')))
    .toBe('[]');
});
