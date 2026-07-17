"""ToUnicode CMap欠落PDF由来の文字化けテキスト除去の検証。"""

from app.rag.index_pipeline import _garbled_ratio, _strip_garbled_lines


def test_strip_garbled_lines_keeps_clean_and_drops_cid_shifted() -> None:
    text = "\n".join(
        [
            "部分洗いも模様替えも簡単。",
            "Kitchen and Sanitary",
            # "App Store, Apple Inc." がCIDずれで化けた実例（実PDFより採取）
            '"QQ\x014UPSF͸"QQMF\x01*OD\x0f',
            # カタカナ「トリプルコート」がギリシャ文字ブロックに化けた実例
            "τ Ϧ ϓ ϧ ί ʔτ",
        ]
    )
    result = _strip_garbled_lines(text)
    assert "部分洗いも模様替えも簡単。" in result
    assert "Kitchen and Sanitary" in result
    assert "QQMF" not in result
    assert "Ϧ" not in result


def test_garbled_ratio_zero_for_normal_japanese() -> None:
    assert _garbled_ratio("設備・内装商品ガイド2026年4月版（第1章）①→②") == 0.0


def test_strip_garbled_lines_empty_input() -> None:
    assert _strip_garbled_lines("") == ""
