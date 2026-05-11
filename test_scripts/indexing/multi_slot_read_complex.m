% Multi-slot read on a complex matrix — both .real and .imag are
% copied per slot.
Z = [1+2i 3-1i 5; 0 7i -2-2i];
disp(Z(:, 2));
disp(Z(1, :));
disp(Z(:, 1:2));
