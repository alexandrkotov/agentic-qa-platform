Feature: Security - Input sanitization and injection protection

  Background:
    Given the API base URL is "http://localhost:3000"

  @security
  Scenario: SQL injection in customer email
    Given a SQL injection payload in the email field
    When I send a POST request to create a customer with that email
    Then the request should not cause a server error
    And the customer should be stored with the email as a literal string, not executed as SQL

  @security
  Scenario: SQL injection in product name
    Given a SQL injection payload in the product name field
    When I send a POST request to create a product with that name
    Then the request should not cause a server error
    And the product should be stored with the name as a literal string, not executed as SQL

  @security
  Scenario: XSS in customer name
    Given I am on the Customers page
    When I add a customer with a script tag payload as the name
    Then the customer name should be rendered as escaped text in the UI, not executed as a script

  @security
  Scenario: XSS in product name
    Given I am on the products page
    When I add a product with a script tag payload as the name
    Then the product name should be rendered as escaped text in the UI, not executed as a script
