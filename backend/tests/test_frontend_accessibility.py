"""Automated tests for frontend accessibility, SEO best practices, and document integrity."""

from pathlib import Path
import re
from html.parser import HTMLParser
import pytest

FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"


class HTMLIntegrityParser(HTMLParser):
    """Custom parser to inspect IDs, landmarks, and headings in HTML files."""
    def __init__(self):
        super().__init__()
        self.ids = []
        self.h1_count = 0
        self.has_skip_link = False
        self.has_main_landmark = False
        self.title_text = ""
        self._in_title = False
        self.meta_tags = []

    def handle_starttag(self, tag, attrs):
        attr_dict = dict(attrs)
        tag_id = attr_dict.get("id")
        if tag_id:
            self.ids.append(tag_id)

        if tag == "title":
            self._in_title = True

        if tag == "h1":
            self.h1_count += 1

        if tag == "a":
            href = attr_dict.get("href", "")
            classes = attr_dict.get("class", "")
            if href == "#main-content" and "skip-link" in classes:
                self.has_skip_link = True

        if tag == "main":
            if attr_dict.get("id") == "main-content":
                self.has_main_landmark = True

        if tag == "meta":
            self.meta_tags.append(attr_dict)

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title_text += data.strip()


def get_html_files():
    """Retrieve all HTML files in frontend directory."""
    files = list(FRONTEND_DIR.glob("*.html"))
    assert len(files) >= 10, f"Expected at least 10 HTML files in {FRONTEND_DIR}, found {len(files)}"
    return files


@pytest.mark.parametrize("html_file", get_html_files(), ids=lambda p: p.name)
def test_html_document_integrity(html_file):
    """Every HTML file must adhere to standard HTML5, SEO, and accessibility guidelines."""
    content = html_file.read_text(encoding="utf-8")

    # 1. Standard HTML5 DOCTYPE and language attribute
    assert "<!DOCTYPE html>" in content or "<!doctype html>" in content.lower(), f"{html_file.name} missing DOCTYPE"
    assert '<html lang="en">' in content or "<html lang='en'>" in content, f"{html_file.name} missing <html lang='en'>"

    parser = HTMLIntegrityParser()
    parser.feed(content)

    # 2. Page Title
    assert len(parser.title_text) > 0, f"{html_file.name} must have a non-empty <title>"

    # 3. Meta Tags (Charset, Viewport, Description)
    has_charset = any("charset" in m for m in parser.meta_tags)
    assert has_charset, f"{html_file.name} must specify meta charset"

    has_viewport = any(m.get("name") == "viewport" for m in parser.meta_tags)
    assert has_viewport, f"{html_file.name} must specify responsive viewport meta"

    has_description = any(m.get("name") == "description" for m in parser.meta_tags)
    assert has_description, f"{html_file.name} must specify SEO meta description"

    # 4. Accessibility Skip Link and Main Landmark
    assert parser.has_skip_link, f"{html_file.name} must contain an accessibility skip link <a href='#main-content' class='skip-link'>"
    assert parser.has_main_landmark, f"{html_file.name} must contain <main id='main-content'>"

    # 5. Heading Structure: Exactly one <h1> per page
    assert parser.h1_count == 1, f"{html_file.name} must have exactly one <h1> element, found {parser.h1_count}"

    # 6. ID Uniqueness (no duplicate IDs on the same page)
    seen_ids = set()
    duplicates = set()
    for tag_id in parser.ids:
        if tag_id in seen_ids:
            duplicates.add(tag_id)
        seen_ids.add(tag_id)
    assert len(duplicates) == 0, f"{html_file.name} contains duplicate HTML IDs: {duplicates}"
