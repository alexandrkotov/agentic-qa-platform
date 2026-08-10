Feature: notifications-and-alerts

  @happy_path @notifications-and-alerts
  Scenario: Certificate expiry notification
    Given I am authenticated in Uptime Kuma for certificate monitoring
    And I navigate to the monitor creation page for certificate tracking
    When I select monitor type "HTTP(s)" for certificate monitoring
    And I enter the certificate monitor friendly name "Certificate Monitor Test"
    And I enter the certificate monitor URL "https://example.com"
    And I enable certificate expiry notification
    And I save the certificate monitor
    Then the certificate monitor should be created successfully
    And the monitor "Certificate Monitor Test" should appear in the monitors list
    And the TLS certificate info should be recorded in the monitor_tls_info table

  @happy_path @notifications-and-alerts
  Scenario: Domain expiry tracking
    Given I am authenticated in Uptime Kuma for domain expiry monitoring
    And I navigate to the monitor creation page for domain tracking
    When I select monitor type "HTTP(s)" for domain monitoring
    And I enter the domain monitor friendly name "Domain Expiry Monitor Test"
    And I enter the domain monitor URL "https://example.com"
    And I enable domain name expiry notification
    And I save the domain monitor
    Then the domain monitor should be created successfully
    And the monitor "Domain Expiry Monitor Test" should appear in the monitors list
    And the domain expiry info should be recorded in the domain_expiry table for "example.com"
