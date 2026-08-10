Feature: status-and-maintenance

  @happy_path @status-and-maintenance
  Scenario: Status page heartbeat data
    Given I am authenticated in Uptime Kuma for status page management
    And I create a status page with name "Test Status Page" and slug "test-status-page"
    And a monitor exists for status page with name "Status Page Monitor"
    And the monitor is assigned to the status page "test-status-page"
    When I request the heartbeat data for status page "test-status-page"
    Then the status page heartbeat response should be successful
    And the heartbeat response should contain heartbeat data for the assigned monitors

  @edge_case @status-and-maintenance
  Scenario: Badge endpoint for non-existent monitor
    When I request the status badge for monitor ID 99999
    Then the badge response should be successful with SVG content
    And the badge should display "N/A" indicating no data available

  @happy_path @status-and-maintenance
  Scenario: Maintenance window effect on monitors
    Given I am authenticated in Uptime Kuma for maintenance management
    And a monitor exists for maintenance testing with name "Maintenance Test Monitor"
    When I create a maintenance window with title "Scheduled Maintenance" for the monitor
    And I activate the maintenance window
    Then the maintenance window should be created successfully
    And the monitor should be associated with the maintenance window in the database
