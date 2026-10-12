Feature: editor

  @happy_path @editor
  Scenario: Create new catalog and add image with hotspot
    Given I open the Editor page with file picker overrides
    When I click the New catalog button and accept the prompt with "Test Catalog"
    And I add an image file to the catalog
    And I click inside the image to place a hotspot at offset 100, 100
    And I fill the link form with name "Part A" and address "part-a"
    And I fill the table row form with name "Part A Item" and SKU "SKU-001"
    And I save the catalog
    Then the catalog should be saved as "Test_Catalog.ecatm"
    And the hotspot should appear on the image
    And the table row "SKU-001" should be visible

  @happy_path @editor
  Scenario: Edit existing hotspot position and data
    Given I open the Editor page with file picker overrides
    When I click the New catalog button and accept the prompt with "Edit Test"
    And I add an image file to the catalog
    And I click inside the image to place a hotspot at offset 50, 50
    And I fill the link form with name "Original" and address "original-addr"
    And I fill the table row form with name "Original Item" and SKU "ORIG-001"
    # TODO (unconfirmed): the UI path for editing an EXISTING hotspot's name/address was not found; only select, move, undo and redo are asserted.
    And I click on the hotspot to select it
    Then the hotspot should be marked as being edited
    When I drag the hotspot to a new position at offset 150, 150
    Then the document title should indicate unsaved changes
    And the hotspot should have moved from its original position
    When I press undo
    Then the hotspot should be back at its original position
    When I press redo
    Then the hotspot should be at the moved position again

  @edge_case @editor
  Scenario: Duplicate hotspot address validation
    # Observed: a second hotspot with an already used address is rejected: the link form stays open, no table row is created.
    Given I open the Editor page with file picker overrides
    When I click the New catalog button and accept the prompt with "Duplicate Test"
    And I add an image file to the catalog
    And I click inside the image to place a hotspot at offset 80, 80
    And I fill the link form with name "First Hotspot" and address "shared-address"
    And I fill the table row form with name "First Item" and SKU "FIRST-001"
    And I click inside the image to place a hotspot at offset 200, 200
    And I submit the link form with name "Second Hotspot" and address "shared-address"
    Then the link form should remain open
    And the row form should not appear
    And the number of saved hotspots on the diagram should be 1

  @edge_case @editor
  Scenario: Empty catalog name
    # Observed: an empty name is not rejected; the editor creates a catalog anyway (Add image becomes enabled).
    Given I open the Editor page with file picker overrides
    Then the Add image button should be disabled
    When I click the New catalog button and accept the prompt with ""
    Then the Add image button should be enabled
    And the Editor should remain functional with title containing "Editor"

  @edge_case @editor
  Scenario: Export protected without HTTPS
    Given I open the Editor page on an insecure context with file picker overrides
    When I create a new catalog named "InsecureTest" via prompt
    And I add a test image to the catalog
    And I click the Export protected button
    And I fill the protection password fields with "securepass123"
    And I click the Protect and download button
    Then no protected catalog file should be downloaded
    And the Editor should still be functional

  @edge_case @editor
  Scenario: Unsaved changes warning
    Given I open the Editor page with file picker overrides for unsaved changes test
    When I create a new catalog named "UnsavedTest" via prompt
    And I add a test image to the catalog
    And I place a hotspot at offset 100, 100 on the image
    And I fill the hotspot link form with name "Test Link" and address "test-addr"
    And I fill the hotspot row form with name "Test Row" and SKU "TST-001"
    Then the document title should start with the unsaved changes marker
    When I attempt to close the page with beforeunload handling
    Then a beforeunload dialog should be triggered

  @edge_case @editor
  Scenario: Large image upload handling
    # Observed: a large image is accepted at its full size (no resize), appears in the image list and marks the catalog unsaved.
    Given I open the Editor page with file picker overrides for large image test
    When I create a new catalog named "LargeImageTest" via prompt
    And I upload a large test image of 5000x5000 pixels
    Then the image list should contain 1 image
    And the document title should start with the unsaved changes marker
