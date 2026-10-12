Feature: viewer

  @happy_path @viewer
  Scenario: Search functionality across catalog
    Given I open the Viewer with the furniture demo catalog
    When I open the search panel in the Viewer
    And I search for "door" in the Viewer
    Then the search results should contain "Door panel · SHK-002"
    When I change the search field filter to "SKU"
    And I search for "shk-001" in the Viewer
    Then the search results should contain "Cornice · SHK-001"
    When I change the search field filter to "Name"
    And I search for "Drawer" in the Viewer
    Then the search results should contain "Drawer · SHK-003"

  @happy_path @viewer
  Scenario: Cart workflow in viewer
    Given I open the Viewer with the furniture demo catalog
    When I add the first item to the cart in the Viewer
    Then the cart button should show "🛒 Cart (1)"
    And the first buy button should show "In cart ✓"
    When I add the second item to the cart in the Viewer
    Then the cart button should show "🛒 Cart (2)"
    When I open the cart dropdown in the Viewer
    Then the cart should contain 2 items with remove buttons
    And the checkout button should show "Checkout (2)"
    When I click the Clear cart button
    Then the cart button should show "🛒 Cart (0)"
    And the first buy button should show "Add to cart"

  @happy_path @viewer
  Scenario: Hotspot-table row highlighting sync
    Given I open the Viewer with the furniture demo catalog
    When I click on the first hotspot in the Viewer
    Then the corresponding table row should be selected
    When I click on the table row with address "shk-002"
    Then the hotspot for address "shk-002" should be highlighted

  @happy_path @viewer
  Scenario: Navigation hotspot between images
    Given I open the Viewer with the living-room demo catalog
    When I click on a navigation hotspot in the Viewer
    Then a different image should be loaded in the Viewer

  @happy_path @viewer
  Scenario: Quiz mode answer validation
    # TODO (unconfirmed): exact quiz interaction mechanics not fully observed; asserting visible render and interactivity
    Given I open the Viewer with the quiz demo catalog
    Then the quiz catalog should be rendered with questions visible
    And the quiz should be interactive with clickable answer options

  @edge_case @viewer
  Scenario: Invalid password for protected catalog
    Given I open the Viewer with the protected demo catalog
    Then the password unlock form should be visible
    When I enter the wrong password "wrongpassword" in the Viewer
    And I click the Unlock button in the Viewer
    Then the error message should show "Wrong password, or the file was modified. Check the password and try again."
    And no table rows should be visible in the Viewer
