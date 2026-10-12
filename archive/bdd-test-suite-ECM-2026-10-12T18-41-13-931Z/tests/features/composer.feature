Feature: composer

  @happy_path @composer
  Scenario: Grid Composer complete workflow
    Given I open the Grid Composer page
    When I set the catalog name to "Test Grid Catalog"
    And I set the tiles per row to "4"
    And I upload 3 test photos for the Grid Composer
    And I upload a CSV table with 3 matching rows for the Grid Composer
    Then the photo status should show "Photos: 3"
    And the table status should show "Rows: 3"
    And the report should show "Every row has a photo and every photo has a row."
    When I click the Build catalog button
    Then the download link for the catalog should be visible

  @edge_case @composer
  Scenario: Grid Composer missing photos
    Given I open the Grid Composer page
    When I set the catalog name to "Missing Photos Catalog"
    And I upload a CSV table with 3 rows but no photos for the Grid Composer
    Then the table status should show "Rows: 3"
    And the photo status should show "No photos chosen yet."
    And the report should show a warning about missing photos for rows 1, 2, 3

  @edge_case @composer
  Scenario: Grid Composer mismatched photo numbers
    Given I open the Grid Composer page
    When I set the catalog name to "Mismatched Catalog"
    And I upload 2 test photos numbered 1 and 2 for the Grid Composer
    And I upload a CSV table with rows numbered 1, 3, 4 for the Grid Composer
    Then the photo status should show "Photos: 2"
    And the table status should show "Rows: 3"
    And the report should show a warning about missing photos for rows 3 and 4
