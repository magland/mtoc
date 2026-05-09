z = [1+2i, 3+4i, 5];
disp(z(1));
disp(z(2));
disp(z(end));
% Operations on indexed complex values
disp(real(z(2)));
disp(imag(z(2)));
disp(abs(z(1)));
% Arithmetic mixing real and complex via indexing
disp(z(1) + z(end));
