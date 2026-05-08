% real / imag / conj on scalar complex and real arguments.
%
% Covers byte-for-byte:
%   - real(complex)        → re part
%   - real(real)           → identity
%   - imag(complex)        → im part
%   - imag(real)           → 0
%   - conj(complex)        → re - im*i
%   - conj(real)           → identity
z = 1 + 2i;
disp(real(z));
disp(imag(z));
disp(conj(z));

w = 3 - 4i;
disp(real(w));
disp(imag(w));
disp(conj(w));

% Real arguments take the real-arg branch.
disp(real(5.5));
disp(imag(5.5));
disp(conj(5.5));
disp(real(-2));
disp(imag(-2));
disp(conj(-2));

% Pure imaginary input.
p = 7i;
disp(real(p));
disp(imag(p));
disp(conj(p));
