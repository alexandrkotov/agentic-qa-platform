Feature: Products
  Manage products via UI and API

  @happy_path @products
  Scenario: Create product with valid data
    Given I am on the products page
    When I add a product with name "Wireless Mouse QA" and price "29.99"
    Then the product "Wireless Mouse QA" should appear in the list with price "$29.99"
    And the product "Wireless Mouse QA" should exist in the database with price "29.99"

  @edge_case @products
  Scenario: Create product with zero price
    # TODO: report only says "verify behavior" for price=0 - exact expected status code is unconfirmed
    Given a product payload with name "Zero Price Item" and price 0
    When I send a POST request to create the product
    Then the response status should indicate creation success or a validation error

  @edge_case @products
  Scenario: Create product with negative price
    Given a product payload with name "Negative Price Item" and price -10
    When I send a POST request to create the product
    Then the response status should be 400 with a validation error

  @edge_case @products
  Scenario: Create product with empty name
    Given a product payload with name "" and price 15.5
    When I send a POST request to create the product
    Then the response status should be 400 with a validation error

  @edge_case @products
  Scenario: Delete product used in existing orders
    # TODO: exact behavior/status code for deleting a product referenced by an OrderItem (foreign key constraint) is unconfirmed by the report
    Given a product that is referenced in an existing order
    When I send a DELETE request for that product
    Then the response status should indicate deletion is blocked or succeeds

  @edge_case @products
  Scenario: Invalid product ID in API
    Given a non-existent product ID
    When I send GET, PATCH, and DELETE requests for that product ID
    Then each response status should be 404
