Feature: security

  @security
  Scenario: XSS in catalog name or hotspot data
    Given I open the Editor page with file picker overrides for XSS testing
    When I create a catalog with XSS payload name "<img src=x onerror=window.__xss=1>"
    And I add a test image for XSS testing
    And I place a hotspot for XSS testing at offset 100, 100
    And I fill the link form with XSS payload name "<img src=x onerror=window.__xss=2>" and address "xss-test-001"
    And I fill the row form with XSS payload name "<img src=x onerror=window.__xss=3>" and SKU "<script>window.__xss=4</script>"
    Then the XSS payload should not execute
    And the XSS text should be visible literally in the page

  @security
  Scenario: Remote catalog URL validation
    # Observed: this is a browser-only app, so a file:// (or unreachable) address is rejected by the browser's own fetch: the copy dialog stays open and shows "Failed to fetch"; no catalog is opened. There is no server-side SSRF layer to test.
    Given I open the Editor page with file picker overrides for remote URL testing
    When I attempt to copy a remote catalog from a file URL "file:///etc/passwd"
    Then the remote copy should be rejected with the error "Failed to fetch"
    And no catalog should be opened
