Feature: Customer Management

  @happy_path @customers
  Scenario: Create customer with valid data
    Given I am on the Customers page
    When I add a customer with a unique email and name "Jane Doe"
    Then the customer should appear in the customers list
    And the customer should exist in the database

  @edge_case @customers
  Scenario: Create customer with duplicate email
    Given a customer exists with a unique email via API
    When I attempt to create another customer via API with the same email
    Then the API should reject the request with an error

  @edge_case @customers
  Scenario: Create customer with empty email
    When I attempt to create a customer via API with empty email and name "Some Name"
    Then the API should reject the request with a validation error

  @edge_case @customers
  Scenario: Create customer with empty name
    When I attempt to create a customer via API with a unique email and empty name
    Then the API should reject the request with a validation error

  @edge_case @customers
  Scenario: Delete customer with existing orders
    Given a customer exists with at least one order
    When I attempt to delete that customer via API
    # TODO: report does not confirm exact expected status code/behavior (FK constraint) - asserting only that request completes without silently succeeding in an inconsistent state
    Then the deletion response behavior should be observed and not assumed

  @edge_case @customers
  Scenario: Invalid customer ID in API
    When I send a GET request to a non-existent customer id
    Then the API should return 404 Not Found
    When I send a PATCH request to a non-existent customer id
    Then the API should return 404 Not Found
    When I send a DELETE request to a non-existent customer id
    Then the API should return 404 Not Found
