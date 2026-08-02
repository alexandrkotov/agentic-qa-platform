Feature: products

  @happy_path @products
  Scenario: Create Product with valid data
    Given I have a unique product name
    When I send a POST request to create a product with name and price 29.99
    Then the product creation response status should be 201
    And the product should exist in the database with the correct name and price
    And the product should appear in the products list via API

  @edge_case @products
  Scenario: Create Product with zero or negative price
    Given I have a unique product name for zero price test
    When I send a POST request to create a product with price 0
    Then the product creation response status should be 201
    When I send a POST request to create a product with price -5.00
    Then the product creation response status should be 400 with a validation error

  @happy_path @products
  Scenario: Delete product with no order items
    Given a product exists that is not used in any order
    When I send a DELETE request to delete the product
    Then the delete product response status should be 200
    And the product should no longer exist in the database

  @edge_case @products
  Scenario: Delete product used in existing order
    # TODO (unconfirmed): The report does not specify whether deleting a product used in an order should cascade, fail with an error, or be blocked. Assuming it returns an error (4xx or 5xx) since OrderItem has a foreign key to Product.
    Given a product exists that is used in an existing order
    When I send a DELETE request to delete the product used in an order
    Then the delete product response should indicate failure or constraint violation

  @happy_path @products
  Scenario: Update product price
    Given a product exists with an initial price of 50.00
    And an order exists containing that product with the original unit price
    When I send a PATCH request to update the product price to 75.00
    Then the update product response status should be 200
    And the product in the database should have the new price 75.00
    And the existing order item should retain the original unit price of 50.00
