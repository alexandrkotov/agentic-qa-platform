Feature: monitor-validation
  Validation scenarios for monitor creation and push endpoints

  @edge_case @monitor-validation
  Scenario: Create monitor with empty URL
    Given I am logged into Uptime Kuma for monitor validation
    When I navigate to the add monitor page for validation testing
    And I select HTTP monitor type for validation
    And I enter the monitor friendly name "Empty URL Monitor"
    And I leave the URL field empty
    And I attempt to save the monitor
    Then the monitor creation should fail with a URL validation error

  @edge_case @monitor-validation
  Scenario: Create monitor with invalid URL format
    Given I am logged into Uptime Kuma for monitor validation
    When I navigate to the add monitor page for validation testing
    And I select HTTP monitor type for validation
    And I enter the monitor friendly name "Invalid URL Monitor"
    And I enter an invalid URL format "not-a-url"
    And I attempt to save the monitor
    Then the monitor creation should fail with an invalid URL error

  @edge_case @monitor-validation
  Scenario: Monitor with zero heartbeat interval
    Given I am logged into Uptime Kuma for monitor validation
    When I navigate to the add monitor page for validation testing
    And I select HTTP monitor type for validation
    And I enter the monitor friendly name "Zero Interval Monitor"
    And I enter a valid monitor URL "https://example.com"
    And I set the heartbeat interval to 0 seconds
    And I attempt to save the monitor
    Then the monitor creation should fail with an interval validation error

  @edge_case @monitor-validation
  Scenario: Push monitor without valid token
    When I send a push request with an invalid token "invalidtoken"
    Then the push response should be 404 with monitor not found message