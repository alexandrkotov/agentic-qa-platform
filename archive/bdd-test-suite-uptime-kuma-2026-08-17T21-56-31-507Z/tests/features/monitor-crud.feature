Feature: monitor-crud

  @happy_path @monitor-crud
  Scenario: Create HTTP monitor with valid URL
    Given I am authenticated as admin in Uptime Kuma
    When I navigate to the add monitor page
    And I select monitor type "HTTP(s)"
    And I enter the friendly name "Test HTTP Monitor"
    And I enter the monitor URL "https://example.com"
    And I click the Save button to create the monitor
    Then the monitor should be created successfully
    And the monitor "Test HTTP Monitor" should appear in the dashboard
    And the monitor should start showing heartbeat status

  @happy_path @monitor-crud
  Scenario: Create ping monitor
    Given I am authenticated as admin in Uptime Kuma
    When I navigate to the add monitor page
    And I select monitor type "Ping"
    And I enter the friendly name "Test Ping Monitor"
    And I enter the hostname "localhost"
    And I click the Save button to create the monitor
    Then the monitor should be created successfully
    And the monitor "Test Ping Monitor" should appear in the dashboard
    And the ping monitor should record uptime data

  @edge_case @monitor-crud
  Scenario: Configure maximum redirects
    Given I am authenticated as admin in Uptime Kuma
    When I navigate to the add monitor page
    And I select monitor type "HTTP(s)"
    And I enter the friendly name "No Redirect Monitor"
    And I enter the monitor URL "https://httpbin.org/redirect/1"
    And I set max redirects to 0
    And I click the Save button to create the monitor
    Then the monitor should be created successfully
    And the monitor should not follow redirects

  @edge_case @monitor-crud
  Scenario: Monitor timeout configuration
    Given I am authenticated as admin in Uptime Kuma
    When I navigate to the add monitor page
    And I select monitor type "HTTP(s)"
    And I enter the friendly name "Short Timeout Monitor"
    And I enter the monitor URL "https://httpbin.org/delay/5"
    And I set request timeout to 1 seconds
    And I click the Save button to create the monitor
    Then the monitor should be created successfully
    And the monitor heartbeat should record timeout errors

  @happy_path @monitor-crud
  Scenario: Monitor with upside down mode
    Given I am authenticated as admin in Uptime Kuma
    When I navigate to the add monitor page
    And I select monitor type "HTTP(s)"
    And I enter the friendly name "Upside Down Monitor"
    And I enter the monitor URL "https://example.com"
    And I enable upside down mode
    And I click the Save button to create the monitor
    Then the monitor should be created successfully
    And the monitor should have upside down mode enabled in the database

  @edge_case @monitor-crud
  Scenario: Group monitor with no children
    Given I am authenticated as admin in Uptime Kuma
    When I navigate to the add monitor page
    And I select monitor type "Group"
    And I enter the friendly name "Empty Group Monitor"
    And I click the Save button to create the monitor
    Then the monitor should be created successfully
    And the group monitor should show pending status
